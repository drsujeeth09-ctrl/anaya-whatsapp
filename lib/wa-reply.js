// WhatsApp inbound-reply orchestrator.
//
// Pattern-matches first (deterministic, never wrong) for the obvious cases:
//   - Quick-reply button taps (Confirm / Reschedule)
//   - STOP / unsubscribe keywords
//   - BOOK / appointment / reschedule keywords
//   - Media (voice / image / document)
//   - Emergency keywords
//
// Falls through to Claude for free-text that doesn't match.  Claude returns
// a short reply + an action token; we honour the action.
//
// Every inbound message is also forwarded to the doctor's email so nothing
// slips through.  See lib/email.js for the SMTP helper.

import { sendMetaTemplate, sendMetaText, cleanPhone } from './meta.js';
import { sendEmail } from './email.js';
import { getClaudeReply } from './claude-chat.js';
import { prescriptionLookupByPhone } from './db.js';

const STOP_REGEX = /^(stop|unsubscribe|opt\s*out|don'?t\s*message|no\s*more|डॉन्ट|बंद\s*करो|మెసేజ్‌లు\s*ఆపండి)/i;
const BOOK_REGEX = /\b(book|appointment|appoint|schedule|slot|reserve|booking|बुक|अपॉइंटमेंट|बुक्क|बुकिंग|బుక్|అపాయింట్‌మెంట్|స్లాట్)/i;
const RESCHEDULE_REGEX = /\b(reschedule|change\s*time|change\s*slot|different\s*time|new\s*time|दूसरा\s*समय|बदलना|మార్చ)/i;
const EMERGENCY_REGEX = /\b(emergency|urgent|severe\s*pain|bleeding|vomiting\s*blood|can'?t\s*breathe|chest\s*pain|fainting|unconscious|ER\s*right\s*now|आपातकाल|गंभीर|एमर्जेंसी|खून|అత్యవసరం|గుండె|నొప్పి)/i;
// "check my prescription" / "send my prescription" / "my medicines" + hi/te.
const PRESCRIPTION_REGEX = /\b(prescription|prescriptions|my\s+medicines?|my\s+medication|my\s+meds|\brx\b)\b|प्रिस्क्रिप्शन|पर्ची|मेरी\s*दवा|ప్రిస్క్రిప్షన్|మందుల\s*చీటీ|నా\s*మందుల/i;

const FORWARD_TO = process.env.FORWARD_INBOUND_TO_EMAIL || 'dr.sujeeth09@gmail.com';
const META_TOKEN = () => process.env.META_WHATSAPP_TOKEN;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Handle one inbound WhatsApp message.  Returns a summary for logging.
 *
 * @param {Object} message  — Meta `messages[]` element from the webhook payload
 * @param {Array}  contacts — Meta `contacts[]` element from the webhook payload
 */
export async function handleInboundMessage(message, contacts) {
  const fromPhone = message.from;
  const wamidIn = message.id;
  const messageType = message.type; // text | button | interactive | audio | image | document | ...

  const contact = (contacts || []).find(c => c.wa_id === fromPhone) || {};
  const profileName = contact.profile?.name || '';
  const firstName = profileName.split(/\s+/)[0] || '';

  let inboundSummary = ''; // for the email forward + log
  let decision = null;     // { reply, action, source }

  // -------------------------------------------------------------------------
  // 1) Pattern-match dispatch
  // -------------------------------------------------------------------------
  if (messageType === 'button' || messageType === 'interactive') {
    const buttonText = message.button?.text
      || message.interactive?.button_reply?.title
      || message.interactive?.list_reply?.title
      || '';
    inboundSummary = `[Button tap] "${buttonText}"`;
    decision = handleButton(buttonText, firstName);
  }
  else if (messageType === 'text') {
    const body = (message.text?.body || '').trim();
    inboundSummary = body;
    decision = handleText(body, firstName);
    if (!decision && PRESCRIPTION_REGEX.test(body)) {
      // Patient asking for their prescription → resend their OWN latest Rx link
      // (deterministic phone-match; never AI-reads the PDF; households hand off).
      decision = await handlePrescriptionRequest({ fromPhone, firstName, lang: detectLanguage(body) });
    }
    if (!decision) {
      // No pattern matched — let Claude generate a contextual reply.
      decision = await aiReply({ message: body, firstName });
    }
  }
  else if (messageType === 'audio' || messageType === 'voice') {
    inboundSummary = '[Voice note received]';
    decision = {
      reply: `Namaste${firstName ? `, ${firstName} garu` : ''} 🙏 — voice notes are best handled by our secretary. We'll get back to you during clinic hours (9 AM–8 PM, Mon–Sat). For urgent matters, call 9963009090.`,
      action: 'handoff',
      source: 'pattern',
    };
  }
  else if (messageType === 'image' || messageType === 'document' || messageType === 'video') {
    inboundSummary = `[${messageType} received]`;
    decision = {
      reply: `Thanks for sharing. Reports and scans are best reviewed during the consultation. To book, visit drsujeeth.com or reply BOOK and we'll send a link.`,
      action: 'handoff',
      source: 'pattern',
    };
  }
  else {
    inboundSummary = `[Unknown message type: ${messageType}]`;
    decision = {
      reply: `Thanks for your message — our secretary will follow up during clinic hours. For urgent matters call 9963009090.`,
      action: 'handoff',
      source: 'pattern',
    };
  }

  // -------------------------------------------------------------------------
  // 2) Send the reply via Meta (free-form text, inside 24h window = free)
  // -------------------------------------------------------------------------
  let outboundResult = null;
  if (decision?.reply) {
    outboundResult = await sendMetaText({
      token: META_TOKEN(),
      to: fromPhone,
      body: decision.reply,
    });
  }

  // Log explicit error if the reply send failed — replySent: false alone in
  // the summary is too easy to miss in Vercel log search.
  if (decision?.reply && outboundResult && outboundResult.success === false) {
    console.error('[wa-reply] sendMetaText FAILED:', JSON.stringify(outboundResult.error));
  }

  // -------------------------------------------------------------------------
  // 3) Honour the action token (if any)
  // -------------------------------------------------------------------------
  let actionResult = null;
  if (decision?.action === 'send_booking_link') {
    // Detect language from the patient's inbound message so we send the
    // template family the patient can actually read.  v2_en, v2_te, and
    // v3_hi are all approved + live per Meta WABA template inventory.
    const patientLang = detectLanguage(inboundSummary || '');
    actionResult = await fireBookingLinkTemplate(fromPhone, firstName, patientLang);
    if (actionResult && actionResult.success === false) {
      console.error('[wa-reply] fireBookingLinkTemplate FAILED:', JSON.stringify(actionResult.error));
    }
  }
  // Other actions are advisory only (logged + email-forwarded);
  // emergency/handoff/opt_out are already addressed in the reply itself.

  // -------------------------------------------------------------------------
  // 4) Forward to doctor's email — every inbound message
  // -------------------------------------------------------------------------
  // Await so the SMTP send completes before the function returns.  Without
  // await, Vercel terminates the lambda before nodemailer finishes the TLS
  // handshake to Gmail, and the email is silently lost.  Same bug class as
  // the whatsapp-webhook handleInboundMessage await fix.
  await forwardToEmail({
    fromPhone,
    profileName,
    inboundSummary,
    ourReply: decision?.reply || '(no reply sent)',
    action: decision?.action || null,
    source: decision?.source || 'unknown',
    wamidIn,
  }).catch(e => console.error('[wa-reply] email forward failed:', e?.message));

  // -------------------------------------------------------------------------
  // 5) Log + return
  // -------------------------------------------------------------------------
  const summary = {
    fromPhone,
    profileName,
    messageType,
    inboundSummary: inboundSummary.slice(0, 200),
    replySource: decision?.source,
    action: decision?.action,
    replySent: outboundResult?.success || false,
    replyWamid: outboundResult?.wamid || null,
    actionFired: !!actionResult,
    actionDetail: actionResult?.success === false ? actionResult.error : (actionResult ? 'ok' : null),
  };
  console.log('[wa-reply]', JSON.stringify(summary));
  return summary;
}

// ---------------------------------------------------------------------------
// Button taps — direct mapping
// ---------------------------------------------------------------------------

function handleButton(buttonText, firstName) {
  const t = (buttonText || '').toLowerCase().trim();
  if (/^confirm|నిర్ధారించ|पुष्टि/.test(t)) {
    // KNOWN LIMITATION: this handler is stateless — a button tap carries only
    // its label, not which reminder template (in-clinic vs online) it came
    // from, so teleconsult confirms also get the in-clinic copy + map link.
    // Online patients still have the Join-video-call button in the reminder.
    return {
      reply: `Thanks${firstName ? ', ' + firstName + ' garu' : ''}! See you at Apollo Clinic, Manikonda. Please arrive 10 minutes early and carry any previous reports.\n\nDirections: https://maps.app.goo.gl/AhMZA5KfEaymNHay6`,
      action: null,
      source: 'pattern_button_confirm',
    };
  }
  if (/^reschedule|మార్చ|पुनर्निर्धारित/.test(t)) {
    return {
      reply: `No problem${firstName ? ', ' + firstName + ' garu' : ''} — sending you a fresh booking link so you can pick a new time.`,
      action: 'send_booking_link',
      source: 'pattern_button_reschedule',
    };
  }
  // Unknown button — generic ack
  return {
    reply: `Got it — our secretary will follow up during clinic hours.`,
    action: 'handoff',
    source: 'pattern_button_unknown',
  };
}

// ---------------------------------------------------------------------------
// Text — pattern match first, fall through to Claude
// ---------------------------------------------------------------------------

function handleText(body, firstName) {
  if (!body) {
    return {
      reply: `Namaste${firstName ? `, ${firstName} garu` : ''} 🙏 — didn't catch that. Could you say it again?`,
      action: null,
      source: 'pattern_empty',
    };
  }
  if (STOP_REGEX.test(body)) {
    return {
      reply: `Got it${firstName ? ', ' + firstName + ' garu' : ''} — we'll stop sending you reminders. Reply START anytime to receive them again.`,
      action: 'opt_out',
      source: 'pattern_stop',
    };
  }
  if (EMERGENCY_REGEX.test(body)) {
    return {
      reply: `If this is urgent, please go to Apollo Hospitals Emergency, Jubilee Hills, right away. For non-urgent matters, reply with details and our team will follow up.`,
      action: 'emergency',
      source: 'pattern_emergency',
    };
  }
  if (RESCHEDULE_REGEX.test(body) || BOOK_REGEX.test(body)) {
    return {
      reply: `Sure${firstName ? ', ' + firstName + ' garu' : ''} — sending you the booking link now. Pick a time that works and complete payment to confirm your slot.`,
      action: 'send_booking_link',
      source: 'pattern_book',
    };
  }
  // Fall through to Claude
  return null;
}

// ---------------------------------------------------------------------------
// AI fallback wrapper — used by the webhook when handleText returns null
// ---------------------------------------------------------------------------

export async function aiReply({ message, firstName, context }) {
  const r = await getClaudeReply({ message, firstName, context });
  if (!r.ok || !r.reply) {
    // Final safety net — if Claude is unreachable, generic ack.
    return {
      reply: `Thanks for your message${firstName ? ', ' + firstName + ' garu' : ''} — our secretary will follow up during clinic hours (9 AM–8 PM, Mon–Sat). For urgent matters call 9963009090.`,
      action: 'handoff',
      source: 'ai_fallback_unavailable',
      claudeError: r.error,
    };
  }
  return {
    reply: r.reply,
    action: r.action,
    source: 'ai',
    claudeRaw: r.raw,
  };
}

// ---------------------------------------------------------------------------
// Prescription self-service: patient texts "check my prescription" → resend
// their OWN latest Rx link. Safeguards: only when exactly ONE patient is on
// the number (shared family numbers → hand off, never guess); only an existing
// doctor-generated link (no AI reading/creating content); reuses the proven
// send-prescription bridge for the actual WhatsApp send.
// ---------------------------------------------------------------------------

async function handlePrescriptionRequest({ fromPhone, firstName, lang }) {
  const tenDigit = String(fromPhone || '').replace(/[^0-9]/g, '').slice(-10);
  let lookup;
  try {
    lookup = await prescriptionLookupByPhone(tenDigit);
  } catch (e) {
    console.error('[wa-reply] rx lookup failed:', e?.message);
    return { reply: `Thanks${firstName ? ', ' + firstName + ' garu' : ''} — our team will share your prescription shortly. For anything urgent call 9963009090.`, action: 'handoff', source: 'rx_lookup_error' };
  }
  if (!lookup || lookup.patientCount === 0) {
    return { reply: `Namaste${firstName ? `, ${firstName} garu` : ''} 🙏 — I couldn't find your records on this number. Please call the clinic at 9963009090 (Mon–Sat, 9 AM–8 PM) or book a visit at drsujeeth.com.`, action: 'handoff', source: 'rx_no_match' };
  }
  if (lookup.patientCount >= 2) {
    return { reply: `More than one patient is registered on this number. Please reply with the patient's full name and we'll send the right prescription.`, action: 'handoff', source: 'rx_household' };
  }
  if (!lookup.publicLinkId) {
    return { reply: `Namaste${firstName ? `, ${firstName} garu` : ''} 🙏 — I found your record but there's no shareable prescription on file yet. Please contact the clinic at 9963009090.`, action: 'handoff', source: 'rx_no_link' };
  }
  // Exactly one patient + a link → resend via the send-prescription bridge.
  const name = [lookup.patient?.salutation, lookup.patient?.firstName, lookup.patient?.lastName].filter(Boolean).join(' ').trim() || firstName || 'Patient';
  let sent = false;
  try {
    const base = process.env.SELF_BASE_URL || 'https://anaya-whatsapp.vercel.app';
    const r = await fetch(`${base}/api/send-prescription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bridge-key': process.env.EMR_WABA_BRIDGE_KEY || '' },
      body: JSON.stringify({ patient_name: name, phone: fromPhone, public_link_id: lookup.publicLinkId, language: lang || 'en' }),
    });
    const j = await r.json().catch(() => ({}));
    sent = !!j.success;
    if (!sent) console.error('[wa-reply] rx resend failed:', JSON.stringify(j).slice(0, 200));
  } catch (e) {
    console.error('[wa-reply] rx resend error:', e?.message);
  }
  if (sent) {
    return { reply: `Here's your latest prescription${firstName ? ', ' + firstName + ' garu' : ''} — I've just sent the PDF to this number. Reply if you need anything else.`, action: 'sent_prescription', source: 'rx_resend' };
  }
  return { reply: `Sorry${firstName ? ', ' + firstName + ' garu' : ''}, I couldn't send your prescription just now — our team will follow up, or call 9963009090.`, action: 'handoff', source: 'rx_resend_failed' };
}

// ---------------------------------------------------------------------------
// Action: fire booking-link template (also used by the rescheduling flow)
// ---------------------------------------------------------------------------

async function fireBookingLinkTemplate(phone, firstName, language = 'en') {
  // 2026-05-19: Route to the right template family by patient language.
  // Approved templates per Meta inventory:
  //   en → clinic_booking_link_v2_en
  //   te → clinic_booking_link_v2_te
  //   hi → clinic_booking_link_v3_hi  (v2_hi was misclassified MARKETING by
  //         Meta's classifier and silently dropped on first-send; v3_hi was
  //         reworded as transactional and approved UTILITY)
  let templateName = 'clinic_booking_link_v2_en';
  let templateLang = 'en';
  if (language === 'te') {
    templateName = 'clinic_booking_link_v2_te';
    templateLang = 'te';
  } else if (language === 'hi') {
    templateName = 'clinic_booking_link_v3_hi';
    templateLang = 'hi';
  }
  // Respectful address: the te template body already carries the honorific
  // ("నమస్కారం {{1}} గారు") and v3_hi carries "{{1}} जी", so appending "garu"
  // there would double it. Only the English body ("Hello {{1}}, ...") needs
  // " garu" appended — and only when we actually know a name.
  const greetName = (templateLang === 'en' && firstName)
    ? `${firstName} garu`
    : (firstName || 'there');
  return sendMetaTemplate({
    token: META_TOKEN(),
    to: phone,
    template: templateName,
    language: templateLang,
    parameters: [
      { type: 'text', text: greetName },
      { type: 'text', text: 'regular' },
      { type: 'text', text: '1000' },
    ],
  });
}

/**
 * Detect language from inbound text by Unicode script.
 * Returns 'te' (Telugu), 'hi' (Devanagari/Hindi), or 'en' default.
 * Matched if the text contains ANY character in that script.
 */
function detectLanguage(text) {
  if (!text) return 'en';
  if (/[ఀ-౿]/.test(text)) return 'te';  // Telugu block
  if (/[ऀ-ॿ]/.test(text)) return 'hi';  // Devanagari block (Hindi/Marathi/etc.)
  return 'en';
}

// ---------------------------------------------------------------------------
// Email forwarding — every inbound message lands in doctor's Gmail inbox
// ---------------------------------------------------------------------------

async function forwardToEmail({ fromPhone, profileName, inboundSummary, ourReply, action, source, wamidIn }) {
  if (!FORWARD_TO) return;
  const subj = `WhatsApp: ${profileName || fromPhone} — ${inboundSummary.slice(0, 50)}`;
  const html = `
    <!DOCTYPE html><html><body style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.55">
      <div style="max-width:640px;margin:0 auto;padding:18px">
        <div style="background:#1E40AF;color:#fff;padding:14px 18px;border-radius:8px 8px 0 0">
          <strong style="font-size:15px">Inbound WhatsApp message</strong>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:0;padding:16px 18px;border-radius:0 0 8px 8px">
          <table cellpadding="0" cellspacing="0" border="0" style="font-size:13px;width:100%">
            <tr><td style="color:#6b7280;width:120px;padding:4px 0">From</td><td><strong>${escapeHtml(profileName || '(unknown)')}</strong> &nbsp;<span style="color:#6b7280">+${escapeHtml(fromPhone)}</span></td></tr>
            <tr><td style="color:#6b7280;padding:4px 0">Received</td><td>${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</td></tr>
            <tr><td style="color:#6b7280;padding:4px 0;vertical-align:top">Message</td><td><div style="padding:10px 12px;background:#f8fafc;border-left:3px solid #0ea5e9;border-radius:3px;white-space:pre-wrap">${escapeHtml(inboundSummary)}</div></td></tr>
            <tr><td style="color:#6b7280;padding:8px 0;vertical-align:top">Auto-reply</td><td><div style="padding:10px 12px;background:#f0fdf4;border-left:3px solid #15803d;border-radius:3px;white-space:pre-wrap">${escapeHtml(ourReply)}</div></td></tr>
            <tr><td style="color:#6b7280;padding:4px 0">Action</td><td><code style="background:#fef3c7;padding:2px 6px;border-radius:3px;font-size:11px">${escapeHtml(action || 'none')}</code> &nbsp;<span style="color:#94a3b8">via ${escapeHtml(source)}</span></td></tr>
            ${wamidIn ? `<tr><td style="color:#6b7280;padding:4px 0">wamid</td><td style="color:#94a3b8;font-family:monospace;font-size:11px">${escapeHtml(wamidIn)}</td></tr>` : ''}
          </table>
          <p style="margin:18px 0 0;font-size:12px;color:#6b7280">
            Reply directly on WhatsApp using the clinic's verified business profile (Dr Sujeeths Healthcare Clinic, +91 94849 57099) to follow up.
          </p>
        </div>
      </div>
    </body></html>
  `;
  return sendEmail({
    to: FORWARD_TO,
    subject: subj,
    html,
    text: `Inbound WhatsApp from ${profileName || fromPhone} (+${fromPhone})\n\nMessage: ${inboundSummary}\n\nAuto-reply: ${ourReply}\n\nAction: ${action || 'none'} (via ${source})\nwamid: ${wamidIn || ''}\n`,
  });
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
