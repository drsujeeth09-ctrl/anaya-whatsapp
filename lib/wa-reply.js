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

const STOP_REGEX = /^(stop|unsubscribe|opt\s*out|don'?t\s*message|no\s*more|डॉन्ट|बंद\s*करो|మెసేజ్‌లు\s*ఆపండి)/i;
const BOOK_REGEX = /\b(book|appointment|appoint|schedule|slot|reserve|booking|बुक|अपॉइंटमेंट|बुक्क|बुकिंग|బుక్|అపాయింట్‌మెంట్|స్లాట్)/i;
const RESCHEDULE_REGEX = /\b(reschedule|change\s*time|change\s*slot|different\s*time|new\s*time|दूसरा\s*समय|बदलना|మార్చ)/i;
const EMERGENCY_REGEX = /\b(emergency|urgent|severe\s*pain|bleeding|vomiting\s*blood|can'?t\s*breathe|chest\s*pain|fainting|unconscious|ER\s*right\s*now|आपातकाल|गंभीर|एमर्जेंसी|खून|అత్యవసరం|గుండె|నొప్పి)/i;

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
    if (!decision) {
      // No pattern matched — let Claude generate a contextual reply.
      decision = await aiReply({ message: body, firstName });
    }
  }
  else if (messageType === 'audio' || messageType === 'voice') {
    inboundSummary = '[Voice note received]';
    decision = {
      reply: `Hi ${firstName || 'there'} — voice notes are best handled by our secretary. We'll get back to you during clinic hours (9 AM–8 PM, Mon–Sat). For urgent matters, call 9963009090.`,
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

  // -------------------------------------------------------------------------
  // 3) Honour the action token (if any)
  // -------------------------------------------------------------------------
  let actionResult = null;
  if (decision?.action === 'send_booking_link') {
    actionResult = await fireBookingLinkTemplate(fromPhone, firstName);
  }
  // Other actions are advisory only (logged + email-forwarded);
  // emergency/handoff/opt_out are already addressed in the reply itself.

  // -------------------------------------------------------------------------
  // 4) Forward to doctor's email — every inbound message
  // -------------------------------------------------------------------------
  forwardToEmail({
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
    return {
      reply: `Thanks${firstName ? ', ' + firstName : ''}! See you at Apollo Clinic, Manikonda. Please arrive 10 minutes early and carry any previous reports.`,
      action: null,
      source: 'pattern_button_confirm',
    };
  }
  if (/^reschedule|మార్చ|पुनर्निर्धारित/.test(t)) {
    return {
      reply: `No problem${firstName ? ', ' + firstName : ''} — sending you a fresh booking link so you can pick a new time.`,
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
      reply: `Hi${firstName ? ' ' + firstName : ''}, didn't catch that. Could you say it again?`,
      action: null,
      source: 'pattern_empty',
    };
  }
  if (STOP_REGEX.test(body)) {
    return {
      reply: `Got it${firstName ? ', ' + firstName : ''} — we'll stop sending you reminders. Reply START anytime to receive them again.`,
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
      reply: `Sure${firstName ? ', ' + firstName : ''} — sending you the booking link now. Pick a time that works and complete payment to confirm your slot.`,
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
      reply: `Thanks for your message${firstName ? ', ' + firstName : ''} — our secretary will follow up during clinic hours (9 AM–8 PM, Mon–Sat). For urgent matters call 9963009090.`,
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
// Action: fire booking-link template (also used by the rescheduling flow)
// ---------------------------------------------------------------------------

async function fireBookingLinkTemplate(phone, firstName) {
  // Default to English; Claude will reply in patient's language but the
  // template itself only has en/te/hi — we use en as the safe default.
  // (Future v2: detect language from inbound message and pick _te / _hi.)
  return sendMetaTemplate({
    token: META_TOKEN(),
    to: phone,
    template: 'clinic_booking_link_v2_en',
    language: 'en',
    parameters: [
      { type: 'text', text: firstName || 'there' },
      { type: 'text', text: 'regular' },
      { type: 'text', text: '1000' },
    ],
  });
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
