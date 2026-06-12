// Synthetic uptime monitor for the Anaya voice line.
//
// WHY THIS EXISTS
// ---------------
// Anaya has gone silently dark TWICE for real patients:
//   • 2026-05-08 → 2026-05-24  SIP-trunk break  — ~57 inbound calls, 0 answered
//   • 2026-05-31 → 2026-06-02  DID + channel expiry — line dead, calls just stop
// Both had the IDENTICAL observable: calls simply stop reaching Retell, and
// nobody noticed for days/weeks. There was no heartbeat. This cron IS the
// heartbeat — it would have caught either outage on day 1 instead of day 18.
//
// HOW IT PROBES
// -------------
// Once a day it asks Retell to place a real OUTBOUND call from the clinic DID
// (+91 94849 57099) to a configured test number. That single call exercises
// every layer that failed in the two outages:
//     Retell agent alive  →  LLM responds  →  VoiceLink trunk 166 bridges  →
//     DID is active (not expired)  →  both wallets clear  →  PSTN leg dials out
// If the synthetic call cannot be placed onto the PSTN, we email (and best-
// effort WhatsApp) an alert immediately.
//
// COVERAGE CAVEAT (read me)
// -------------------------
// Outbound and inbound share trunk 166 + the same DID + the same wallet gate,
// so this probe catches both DOCUMENTED outage modes. The one thing it cannot
// guarantee is a hypothetical INBOUND-ONLY routing fault (VoiceLink's inbound
// route to Retell breaks while outbound still works). The truly faithful
// inbound test is to dial the DID from an EXTERNAL provider (e.g. the dormant
// Twilio +1 number) and confirm Anaya answers — sketched at the bottom of this
// file as the v2 upgrade. Ship this first; it covers what actually broke.
//
// AUTH / INVOCATION
// -----------------
//   • Vercel cron sends `Authorization: Bearer ${CRON_SECRET}` on schedule.
//   • GET without auth  → health banner (no call placed).
//   • POST ...?dryRun=1 → validates config + env wiring, places NO call,
//                         sends NO alert. Use this to verify setup safely.
//   • POST ...?selftest=alert → sends ONE test alert email so you can confirm
//                         the alert path works (does place no call). Opt-in only.
//
// Schedule:  vercel.json -> "schedule": "30 2 * * *"  (02:30 UTC = 08:00 IST),
//            i.e. a daily check before the clinic day starts.

import { sendEmail } from '../lib/email.js';
import { sendMetaText } from '../lib/meta.js';

const RETELL_API_BASE = 'https://api.retellai.com';

// The clinic DID, registered in Retell as the from-number. Override via env if
// the number ever changes.
const FROM_NUMBER = process.env.RETELL_FROM_NUMBER || '+919484957099';

// Where alerts go. Email is the RELIABLE channel (no 24h-window constraint).
const ALERT_EMAIL = process.env.MONITOR_ALERT_EMAIL || 'dr.sujeeth09@gmail.com';
// WhatsApp alert is BEST-EFFORT: free-form text only lands if the recipient has
// messaged the WABA in the last 24h. Treat it as a bonus, never the only leg.
const ALERT_WHATSAPP = process.env.MONITOR_ALERT_WHATSAPP || '919866134340';

const RETELL_CALL_HISTORY = 'https://dashboard.retellai.com/call-history';

// --- Disconnection-reason classification ------------------------------------
// HEALTHY = the call was demonstrably placed onto the PSTN (the whole chain
// worked), regardless of whether the far end picked up. dial_no_answer / busy
// are HEALTHY — they prove the trunk dialed out.
const HEALTHY_REASONS = new Set([
  'user_hangup', 'agent_hangup', 'call_transfer', 'voicemail_reached',
  'machine_detected', 'inactivity', 'max_duration_reached',
  'dial_no_answer', 'dial_busy',
]);

// FAILURE = trunk / provider / registration / wallet / Retell-side faults — the
// exact class of both documented outages.
const FAILURE_REASONS = new Set([
  'dial_failed', 'registration_failed', 'no_valid_payment',
  'invalid_destination', 'telephony_provider_unavailable',
  'telephony_provider_permission_denied',
  'error_twilio', 'error_retell', 'error_unknown',
  'error_no_audio_received', 'error_user_not_joined',
  'error_llm_websocket_open',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  // Health check — GET without auth (never places a call).
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'anaya-line-monitor',
      tip: 'POST with Authorization: Bearer $CRON_SECRET. Add ?dryRun=1 to validate config without calling.',
      schedule: '30 2 * * * UTC (08:00 IST daily)',
    });
  }

  // Auth gate (same contract as run-daily-reminders).
  const auth = req.headers['authorization'] || req.headers['Authorization'];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = process.env.RETELL_API_KEY;
  const toNumber = process.env.MONITOR_TO_NUMBER;

  const cfg = {
    from: FROM_NUMBER,
    to: toNumber || '(MONITOR_TO_NUMBER not set)',
    alertEmail: ALERT_EMAIL,
    alertWhatsapp: ALERT_WHATSAPP,
    env: {
      RETELL_API_KEY: !!apiKey,
      MONITOR_TO_NUMBER: !!toNumber,
      CRON_SECRET: !!process.env.CRON_SECRET,
      META_WHATSAPP_TOKEN: !!process.env.META_WHATSAPP_TOKEN,
      gmail: !!(process.env.GMAIL_USER && process.env.GMAIL_PASSWORD) || !!process.env.SMTP_HOST,
    },
  };

  // ---- selftest=alert : prove the alert path without placing a call --------
  if (req.query?.selftest === 'alert') {
    const r = await sendAlert({
      verdict: 'SELFTEST',
      reason: 'manual selftest',
      detail: 'This is a test of the Anaya monitor alert path. No real outage.',
      callId: null,
    });
    return res.status(200).json({ selftest: true, alert: r });
  }

  // ---- dryRun=1 : validate wiring, place NO call, send NO alert -------------
  const dryRun = req.query?.dryRun === '1' || req.query?.dryRun === 'true';
  if (dryRun) {
    const ready = cfg.env.RETELL_API_KEY && cfg.env.MONITOR_TO_NUMBER &&
      cfg.env.CRON_SECRET && cfg.env.gmail;
    return res.status(200).json({
      dryRun: true,
      ready,
      cfg,
      didExpiry: checkDidExpiry(),
      note: ready
        ? 'Config looks complete. Remove ?dryRun=1 (or let the cron fire) to run a real probe.'
        : 'Missing required env — see cfg.env booleans (all must be true).',
    });
  }

  // ---- Real probe ----------------------------------------------------------
  if (!apiKey) return res.status(500).json({ error: 'RETELL_API_KEY not set' });
  if (!toNumber) return res.status(500).json({ error: 'MONITOR_TO_NUMBER not set' });

  const startedAt = new Date().toISOString();
  let probe;
  try {
    probe = await runProbe({ apiKey, from: FROM_NUMBER, to: toNumber });
  } catch (e) {
    // Could not even reach Retell to place the call — that itself is an outage
    // (Retell down, key revoked, or network). Alert.
    probe = {
      verdict: 'FAIL',
      reason: 'retell_api_unreachable',
      detail: e.message,
      callId: null,
    };
  }

  const didExpiry = checkDidExpiry();

  // Alert on failure, on unrecognised disconnect reasons, or on a near DID
  // expiry. Optionally email on success too (MONITOR_ALWAYS_EMAIL=1) so you
  // get a daily "still alive" confirmation and know the monitor itself runs.
  let alert = null;
  const mustAlert = probe.verdict === 'FAIL' || didExpiry.warn;
  if (mustAlert) {
    alert = await sendAlert({ ...probe, didExpiry });
  } else if (process.env.MONITOR_ALWAYS_EMAIL === '1') {
    alert = await sendAlert({ ...probe, didExpiry, healthyHeartbeat: true });
  }

  const summary = { startedAt, finishedAt: new Date().toISOString(), cfg: { from: cfg.from, to: cfg.to }, probe, didExpiry, alert };
  // Non-2xx on FAIL so Vercel's log filter + any external uptime ping on this
  // endpoint also flags it.
  return res.status(probe.verdict === 'FAIL' ? 503 : 200).json(summary);
}

// Place the synthetic call and poll until we can render a verdict, bounded so
// the whole handler stays under maxDuration (60s).
async function runProbe({ apiKey, from, to }) {
  const createRes = await fetch(`${RETELL_API_BASE}/v2/create-phone-call`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from_number: from,
      to_number: to,
      // Tag the call so it's easy to spot + exclude from real-traffic audits.
      metadata: { synthetic_monitor: true, source: 'anaya-line-monitor' },
      retell_llm_dynamic_variables: { is_synthetic_monitor: 'true' },
    }),
  });
  const created = await createRes.json().catch(() => ({}));
  if (!createRes.ok || !created.call_id) {
    return {
      verdict: 'FAIL',
      reason: created?.error_message ? 'create_call_rejected' : `http_${createRes.status}`,
      detail: created?.error_message || JSON.stringify(created).slice(0, 300),
      callId: created?.call_id || null,
    };
  }

  const callId = created.call_id;

  // Poll get-call. dial_no_answer needs the full PSTN ring (~30s) to resolve,
  // so we poll ~47s: an initial settle, then up to 11 × 4s.
  await sleep(3000);
  let call = created;
  for (let i = 0; i < 11; i++) {
    call = await getCall(apiKey, callId);
    const status = call?.call_status;
    if (status === 'ended' || status === 'error') break;
    // If it reached `ongoing`, the trunk already bridged the call — that alone
    // is positive proof the line is up; no need to wait for it to finish.
    if (status === 'ongoing') break;
    await sleep(4000);
  }

  return classify(call, callId);
}

async function getCall(apiKey, callId) {
  const r = await fetch(`${RETELL_API_BASE}/v2/get-call/${callId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return r.json();
}

// Turn a (possibly still-in-flight) Retell call object into PASS / FAIL.
// Default-DENY on anything we can't positively recognise as healthy — better a
// rare review ping than another silent 18-day outage.
function classify(call, callId) {
  const status = call?.call_status;
  const reason = call?.disconnection_reason || null;
  const durationMs = call?.end_timestamp && call?.start_timestamp
    ? call.end_timestamp - call.start_timestamp
    : null;
  const base = { callId, status, reason, durationMs, callHistory: `${RETELL_CALL_HISTORY}?history=${callId}` };

  // Connected and still talking — trunk demonstrably up.
  if (status === 'ongoing') {
    return { ...base, verdict: 'PASS', detail: 'call connected (ongoing) — trunk bridged' };
  }
  // Never progressed past registration within the window — could not place it.
  if (status === 'registered') {
    return { ...base, verdict: 'FAIL', detail: 'call never left "registered" — could not place onto PSTN' };
  }
  if (status === 'error') {
    return { ...base, verdict: 'FAIL', detail: `call_status=error (${reason || 'no reason'})` };
  }
  // status === 'ended' (or anything else): decide on the disconnect reason.
  if (reason && HEALTHY_REASONS.has(reason)) {
    return { ...base, verdict: 'PASS', detail: `healthy disconnect (${reason})` };
  }
  if (reason && FAILURE_REASONS.has(reason)) {
    return { ...base, verdict: 'FAIL', detail: `trunk/provider failure (${reason})` };
  }
  // Unrecognised reason → treat as FAIL-for-review so it can't hide an outage.
  return {
    ...base,
    verdict: 'FAIL',
    detail: `unrecognised disconnect reason (${reason || 'null'}) — review and allowlist if benign`,
  };
}

// Defensive proactive check for the DID-expiry outage mode. Auto-renew is ON
// (renewed to 2026-11-30) but auto-renew has failed silently before, so warn
// when expiry is within 10 days. Set DID_EXPIRY_ISO whenever you renew.
function checkDidExpiry() {
  const iso = process.env.DID_EXPIRY_ISO; // e.g. '2026-11-30'
  if (!iso) return { warn: false, note: 'DID_EXPIRY_ISO not set — expiry check skipped' };
  const exp = new Date(`${iso}T00:00:00Z`).getTime();
  if (Number.isNaN(exp)) return { warn: false, note: `DID_EXPIRY_ISO unparseable: ${iso}` };
  const days = Math.floor((exp - Date.now()) / 86400000);
  return { warn: days <= 10, daysToExpiry: days, expiry: iso };
}

// Send the alert over email (reliable) + WhatsApp text (best-effort). Returns
// what each channel did so it shows up in the run summary + Vercel logs.
async function sendAlert({ verdict, reason, detail, callId, callHistory, status, durationMs, didExpiry, healthyHeartbeat }) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const up = verdict === 'PASS';

  const subject = healthyHeartbeat
    ? `🟢 Anaya line OK — daily heartbeat (${stamp})`
    : verdict === 'SELFTEST'
      ? `🧪 Anaya monitor — alert path selftest (${stamp})`
      : `🔴 Anaya line DOWN — synthetic call failed (${stamp})`;

  const didLine = didExpiry?.warn
    ? `\n⚠️ DID expiry in ${didExpiry.daysToExpiry} day(s) (${didExpiry.expiry}) — check VoiceLink → DID Management / Auto-Renew.\n`
    : '';

  const runbook = up ? '' : `
NOTE: if the reason is "user_declined" AND you (or whoever holds the test
phone) pressed decline on today's ~08:00 IST test ring, this is a FALSE
alarm — let the call ring out tomorrow. A 0-second user_declined with no
ring at all is the real trunk-reject signature (seen 2026-06-12, channel
expiry) and needs the checklist below.

WHAT TO CHECK (in order — this is the documented outage runbook):
  1. VoiceLink → DID Management: is +919484957099 expired? Is Auto-Renew ON
     (both Reseller AND Client levels)?
  2. VoiceLink wallets: are BOTH the Client and Reseller wallets in credit?
     (Reseller-account quirk — a call drops at 0s if either is empty.)
  3. VoiceLink SIP trunk "RETELL.SUJEETH BASHETTY" (id 166): Active? Routing
     Inbound+Outbound still → trunk 166?
  4. Retell: agent ${process.env.RETELL_MONITOR_AGENT_ID || 'agent_7dd9b1c041690a4ae639c9da0e'}
     published? Account in credit (card on file)?
  5. Open the call: ${callHistory || RETELL_CALL_HISTORY}
`;

  const text =
    `${subject}\n\n` +
    `Verdict: ${verdict}\n` +
    `Reason:  ${reason || '—'}\n` +
    `Detail:  ${detail || '—'}\n` +
    (status ? `Retell call_status: ${status}\n` : '') +
    (durationMs != null ? `Call duration: ${Math.round(durationMs / 1000)}s\n` : '') +
    (callId ? `Call ID: ${callId}\n` : '') +
    didLine +
    runbook +
    `\n— anaya-line-monitor`;

  const html = `<pre style="font:14px/1.5 monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`;

  const out = { email: null, whatsapp: null };
  try {
    const em = await sendEmail({ to: ALERT_EMAIL, subject, html, text });
    out.email = { ok: true, messageId: em.messageId };
  } catch (e) {
    out.email = { ok: false, error: e.message };
  }

  // Best-effort WhatsApp (only lands inside a 24h window — never the sole leg).
  if (!healthyHeartbeat && process.env.META_WHATSAPP_TOKEN && ALERT_WHATSAPP) {
    const wa = await sendMetaText({
      token: process.env.META_WHATSAPP_TOKEN,
      to: ALERT_WHATSAPP,
      body: `${up ? '🟢' : '🔴'} ${subject}\n${reason || ''} — ${detail || ''}`.slice(0, 1000),
    });
    out.whatsapp = wa.success ? { ok: true, wamid: wa.wamid } : { ok: false, error: wa.error };
  }
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// ----------------------------------------------------------------------------
// v2 UPGRADE (not implemented, no vendor chosen) — true inbound probe.
// The outbound probe above shares trunk 166 + DID + wallet with inbound, so it
// already catches both outages we've actually had. The ONLY residual blind spot
// is an inbound-only routing fault. Closing it requires dialling the DID from
// SOME external provider and asserting Anaya answers — but that means standing
// up a new telephony vendor we don't currently have, so it's deliberately left
// as a future follow-up rather than a dependency. (We do NOT use Twilio.)
// ----------------------------------------------------------------------------
