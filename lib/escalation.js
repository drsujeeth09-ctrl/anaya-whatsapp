// Urgency escalation — when an inbound WhatsApp message shows the patient is
// STUCK (wants to reschedule, says they paid, can't reach a human, emergency
// wording), alert the clinic team immediately instead of letting the message
// wait in the morning inbox sweep.
//
// Built 2026-07-04 after a patient sent 9 messages in 2 minutes at 7:37 AM
// trying to confirm a paid same-day appointment ("no reply from the secretary
// since yesterday") and the auto-responder could only loop booking links.
//
// Channels:
//   1. WhatsApp free-form text to ESCALATION_WHATSAPP (falls back to
//      NUDGE_RECIPIENTS = doctor + secretary). Free-form only lands inside a
//      24h session window, so this is best-effort.
//   2. Email with a 🚨 subject to ESCALATION_EMAILS (falls back to
//      FORWARD_INBOUND_TO_EMAIL). Guaranteed channel, no Meta approval needed.
//
// De-dupe: one alert per patient per THROTTLE_MINUTES, tracked durably in
// reminder_logs (reminderType 'escalation_alert', recipient = patient digits)
// so a message burst produces one alert across lambda instances.

import { sendMetaText } from './meta.js';
import { sendEmail } from './email.js';
import { insertReminderLog, lastEscalationAlertAt } from './db.js';

const THROTTLE_MINUTES = 15;

// Local copy of the reschedule intent (wa-reply.js has the canonical one for
// routing; importing it here would be circular).
const RESCHEDULE_REGEX = /\b(reschedule|change\s*time|change\s*slot|different\s*time|new\s*time|दूसरा\s*समय|बदलना|మార్చ)/i;

// "I already paid" — a paid patient left hanging is the worst-case experience.
const PAID_REGEX = /\b(paid|payment\s*(done|made|complete|completed|success)|i'?ve\s*paid|transaction|upi|razorpay)\b|भुगतान|पैसे\s*(भेज|दे)\s*दि|చెల్లించా|డబ్బు\s*కట్టా/i;

// Can't-reach-a-human / waiting / asking the clinic to confirm something.
const FRUSTRATION_REGEX = /no\s*(reply|response|revert|update)|not\s*(responding|reachable|picking|answering)|nobody\s*(picked|answered|called|responded)|no\s*one\s*(picked|answered|called|responded)|still\s*(waiting|no\s)|since\s*(yesterday|morning|last\s*night)|tried\s*call|couldn'?t\s*reach|can'?t\s*reach|call\s*(me\s*)?back|(pls|please)\s*confirm|not\s*confirmed|कोई\s*जवाब|फोन\s*नहीं\s*उठा|జవాబు\s*లేదు|ఫోన్\s*ఎత్తడం\s*లేదు/i;

/**
 * Decide whether this inbound message needs a human alerted right now.
 * Returns { urgent, reasons } — reasons are human-readable, they go straight
 * into the alert message the doctor/secretary reads.
 *
 * @param {Object} args
 * @param {string} [args.text]   inbound free text ('' for media/buttons)
 * @param {string} [args.action] decision action token (emergency/handoff/...)
 * @param {string} [args.source] decision source (pattern_button_reschedule/ai/...)
 */
export function detectEscalation({ text = '', action = null, source = '' } = {}) {
  const reasons = [];
  if (action === 'emergency') reasons.push('EMERGENCY wording — patient redirected to Apollo ER');
  if (source === 'pattern_button_reschedule' || (text && RESCHEDULE_REGEX.test(text))) {
    reasons.push('wants to reschedule');
  }
  if (text && PAID_REGEX.test(text)) reasons.push('says payment already made');
  if (text && FRUSTRATION_REGEX.test(text)) reasons.push('waiting on the clinic / asking for confirmation');
  if (source === 'appt_lookup_not_found') reasons.push('asked to confirm a booking — none found in EMR');
  // Claude judged the message needs a human (complaints, complex questions).
  // Pattern-based handoffs (voice notes, images) are routine and stay quiet.
  if (action === 'handoff' && source === 'ai') reasons.push('AI judged it needs human attention');
  return { urgent: reasons.length > 0, reasons };
}

/**
 * Fire the alert to the clinic team. Never throws — an alert failure must not
 * break the patient-facing reply flow (caller already sent the reply).
 * Returns a summary object for the webhook log.
 */
export async function sendEscalationAlert({ fromPhone, profileName, message, reasons }) {
  const digits = String(fromPhone || '').replace(/[^0-9]/g, '');

  // Durable per-patient throttle via reminder_logs (best-effort: if the DB
  // check fails we still alert — a duplicate beats a silent miss).
  try {
    const last = await lastEscalationAlertAt(digits);
    if (last && Date.now() - new Date(last).getTime() < THROTTLE_MINUTES * 60 * 1000) {
      return { skipped: 'throttled', lastAlertAt: last };
    }
  } catch (e) {
    console.error('[escalation] throttle check failed:', e?.message);
  }

  const recipients = String(process.env.ESCALATION_WHATSAPP || process.env.NUDGE_RECIPIENTS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const emails = String(process.env.ESCALATION_EMAILS || process.env.FORWARD_INBOUND_TO_EMAIL || 'dr.sujeeth09@gmail.com')
    .split(',').map(s => s.trim()).filter(Boolean);
  const token = (process.env.META_WHATSAPP_TOKEN || '').trim();

  const alertText = [
    '🚨 *Patient needs a call back*',
    `Name: ${profileName || '(unknown)'}`,
    `Phone: +${digits}`,
    `Why: ${reasons.join(' · ')}`,
    `Message: "${String(message || '').slice(0, 160)}"`,
    `Reply: https://wa.me/${digits}`,
  ].join('\n');

  const whatsapp = [];
  for (const to of recipients) {
    try {
      const r = await sendMetaText({ token, to, body: alertText });
      whatsapp.push({ to, success: !!r.success, error: r.success ? undefined : r.error });
    } catch (e) {
      whatsapp.push({ to, success: false, error: e?.message });
    }
  }

  const email = [];
  const subject = `🚨 URGENT WhatsApp: ${profileName || '+' + digits} — ${reasons[0]}`;
  for (const to of emails) {
    try {
      await sendEmail({
        to,
        subject,
        text:
          `A patient needs a call back NOW.\n\n` +
          `Name: ${profileName || '(unknown)'}\nPhone: +${digits}\n` +
          `Why: ${reasons.join('; ')}\n\nTheir message:\n"${message}"\n\n` +
          `Reply on WhatsApp: https://wa.me/${digits}\n` +
          `(The patient was told the team has been alerted and will call back.)\n`,
      });
      email.push({ to, success: true });
    } catch (e) {
      email.push({ to, success: false, error: e?.message });
    }
  }

  // Log the alert — this row also arms the throttle for the next message.
  try {
    await insertReminderLog({
      reminderType: 'escalation_alert',
      channel: 'whatsapp',
      recipient: digits,
      status: 'sent',
    });
  } catch (e) {
    console.error('[escalation] reminder_logs insert failed:', e?.message);
  }

  return { whatsapp, email };
}
