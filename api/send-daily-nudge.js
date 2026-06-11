// Daily "forward-ready" WhatsApp nudge — fires at 06:15 IST (00:45 UTC) via Vercel cron.
//
// Publer posts the day's Reel to @drsujeeth at 06:00 IST sharp. This endpoint
// then finds that Reel via the Graph API, merges its link with today's
// challenge message, and WhatsApps a forward-ready message to the doctor +
// secretary (env NUDGE_RECIPIENTS). They long-press -> Forward -> group. Done.
//
// The Cloud API cannot post into WhatsApp groups (no group support at all),
// so this human forward is by design — see WhatsApp-Community-Setup.md.
//
// Auth:   Authorization: Bearer ${CRON_SECRET}
// Health: GET (no auth) returns a service banner.
// Test:   POST ?dryRun=1            -> shows what WOULD be sent
//         POST ?date=2026-06-12     -> run a specific day (still needs auth)
//         POST ?to=9198...          -> override recipients (comma-separated)
//
// Sends template `gut_daily_nudge` (en, UTILITY):
//   {{1}} hook line · {{2}} reel shortcode · {{3}} day number
// Falls back to a free-form text (24h session window) if the template fails.
// No DB idempotency: a duplicate nudge to staff is harmless; manual re-POST
// is a deliberate "send it again".

import { readFileSync } from 'node:fs';
import { sendMetaTemplate, sendMetaText } from '../lib/meta.js';

const GRAPH = 'https://graph.facebook.com/v22.0';
const TEMPLATE = 'gut_daily_nudge';

function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function istDateOf(isoTimestamp) {
  return new Date(isoTimestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function loadSchedule() {
  const url = new URL('../data/gut-challenge-schedule.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

function igToken() {
  const t = process.env.IG_PUBLISH_TOKEN || process.env.META_WHATSAPP_TOKEN;
  if (!t) throw new Error('IG_PUBLISH_TOKEN not set');
  return t.trim();
}

/** Today's published Reel on @drsujeeth (newest first; match by IST date + hook). */
async function findTodaysReel(today, hook) {
  const igUserId = (process.env.IG_USER_ID || '').trim();
  if (!igUserId) throw new Error('IG_USER_ID not set');
  const url = new URL(`${GRAPH}/${igUserId}/media`);
  url.searchParams.set('fields', 'id,permalink,caption,timestamp');
  url.searchParams.set('limit', '10');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${igToken()}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Graph media list -> ${JSON.stringify(data.error || data)}`);

  const todays = (data.data || []).filter((m) => istDateOf(m.timestamp) === today);
  if (!todays.length) return null;
  const hookKey = hook.slice(0, 20);
  return todays.find((m) => String(m.caption || '').startsWith(hookKey)) || todays[0];
}

function shortcodeFrom(permalink) {
  const m = String(permalink || '').match(/\/(?:reel|p|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/** The same message as the template, for the free-form fallback + dryRun preview. */
function composeText({ hook, shortcode, dayNum }) {
  return (
    `🌿 *${hook}*\n\n` +
    `📺 Watch today's video:\nhttps://www.instagram.com/reel/${shortcode}/\n\n` +
    `💬 Questions? Message us → wa.me/919484957099\n` +
    `🩺 Dr. Sujeeth's 42-Day Gut Health Challenge — Day ${dayNum} of 42`
  );
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'gut-daily-nudge',
      schedule: '45 0 * * * UTC (06:15 IST daily, Hobby drift to ~07:15)',
      tip: 'POST with Authorization: Bearer $CRON_SECRET. ?dryRun=1 to preview, ?date=YYYY-MM-DD for a specific day, ?to=91... to override recipients.',
    });
  }

  const auth = req.headers['authorization'] || req.headers['Authorization'];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun = req.query?.dryRun === '1' || req.query?.dryRun === 'true';
  const today = req.query?.date || todayIST();
  const recipients = String(req.query?.to || process.env.NUDGE_RECIPIENTS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  const summary = { runAt: new Date().toISOString(), today, dryRun, recipients: recipients.length };

  if (!recipients.length) {
    return res.status(500).json({ ...summary, error: 'NUDGE_RECIPIENTS not set' });
  }

  let entry;
  try {
    entry = loadSchedule().find((e) => e.date === today);
  } catch (e) {
    return res.status(500).json({ ...summary, error: `could not load schedule: ${e.message}` });
  }
  if (!entry) {
    return res.status(200).json({ ...summary, note: 'no challenge day scheduled for today — nothing to do' });
  }

  const hook = String(entry.caption || '').split('\n')[0].trim();
  const dayNum = String(entry.day || '').replace(/\D/g, '') || '0';
  summary.ep = entry.ep;
  summary.day = entry.day;

  let reel;
  try {
    reel = await findTodaysReel(today, hook);
  } catch (e) {
    return res.status(500).json({ ...summary, error: `Graph lookup failed: ${e.message}` });
  }
  if (!reel) {
    return res.status(200).json({
      ...summary, sent: false,
      note: 'no Reel found on @drsujeeth for today yet (Publer may not have posted) — re-POST later to retry',
    });
  }
  const shortcode = shortcodeFrom(reel.permalink);
  if (!shortcode) {
    return res.status(500).json({ ...summary, error: `could not parse shortcode from ${reel.permalink}` });
  }
  summary.reel = { permalink: reel.permalink, shortcode };

  if (dryRun) {
    return res.status(200).json({ ...summary, wouldSend: composeText({ hook, shortcode, dayNum }) });
  }

  const token = (process.env.META_WHATSAPP_TOKEN || '').trim();
  const results = [];
  for (const to of recipients) {
    let r = await sendMetaTemplate({
      token, to, template: TEMPLATE, language: 'en',
      parameters: [
        { type: 'text', text: hook },
        { type: 'text', text: shortcode },
        { type: 'text', text: dayNum },
      ],
    });
    let via = 'template';
    if (!r.success) {
      // Template not approved yet / paused -> best-effort free-form (24h window only).
      const fallback = await sendMetaText({ token, to, body: composeText({ hook, shortcode, dayNum }) });
      if (fallback.success) { r = fallback; via = 'text-fallback'; }
      else r.fallbackError = fallback.error;
    }
    results.push({ to, via, success: r.success, wamid: r.wamid, error: r.success ? undefined : r.error });
  }

  const allOk = results.every((x) => x.success);
  return res.status(allOk ? 200 : 500).json({ ...summary, sent: allOk, results });
}
