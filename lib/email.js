// Gmail SMTP email helper for the anaya-whatsapp project.
//
// Mirrors the EMR's notifications.js pattern: SMTP_HOST > Gmail service
// fallback.  Reads GMAIL_USER + GMAIL_PASSWORD + GMAIL_FROM from env.

import nodemailer from 'nodemailer';
import {
  renderFollowUpReminderEmail,
  renderAppointmentReminderEmail,
} from './follow-up-email-templates.js';

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  const smtpHost = process.env.SMTP_HOST;
  if (smtpHost) {
    const port = parseInt(process.env.SMTP_PORT || '465', 10);
    _transporter = nodemailer.createTransport({
      host: smtpHost,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    return _transporter;
  }

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_PASSWORD;
  if (!user || !pass) {
    throw new Error('Email not configured: set GMAIL_USER + GMAIL_PASSWORD or SMTP_*');
  }
  _transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') }, // App passwords accept either; strip spaces to be safe
  });
  return _transporter;
}

function fromHeader() {
  const fromAddr = process.env.GMAIL_FROM || process.env.GMAIL_USER || 'noreply@drsujeeth.com';
  return `Dr. Sujeeth Kumar <${fromAddr}>`;
}

/** Send a plain email. Pass `from` to override the default branded From header
 *  (the reminder digest uses this to send from the real Gmail account so
 *  SPF/DKIM/DMARC stay aligned and it lands in the inbox, not spam). */
export async function sendEmail({ to, subject, html, text, from }) {
  const transporter = getTransporter();
  const opts = { from: from || fromHeader(), to, subject, html };
  if (text) opts.text = text;
  return transporter.sendMail(opts);
}

/** Send the follow-up reminder email. */
export async function sendFollowUpReminderEmail(patient, followUpDate) {
  if (!patient?.email) throw new Error('No email on patient — cannot send');
  const { subject, html, text } = renderFollowUpReminderEmail({ patient, followUpDate });
  return sendEmail({ to: patient.email, subject, html, text });
}

/** Send the 24-hour appointment reminder email.
 *  `opts` is optional: { appointmentType, meetLink } switches the template to
 *  its online-consultation variant for TELECONSULT rows with a meet link. */
export async function sendAppointmentReminderEmail(patient, appointmentDate, appointmentTime, opts = {}) {
  if (!patient?.email) throw new Error('No email on patient — cannot send');
  const { subject, html, text } = renderAppointmentReminderEmail({
    patient,
    appointmentDate,
    appointmentTime,
    appointmentType: opts.appointmentType,
    meetLink: opts.meetLink,
  });
  return sendEmail({ to: patient.email, subject, html, text });
}

// Roll a reminderStats().delivery array up into per-channel totals.
function aggregateDelivery(delivery) {
  const a = {
    whatsapp: { sent: 0, delivered: 0, read: 0, failed: 0, total: 0 },
    email:    { sent: 0, delivered: 0, read: 0, failed: 0, total: 0 },
  };
  for (const r of (delivery || [])) {
    const c = a[r.channel];
    if (!c) continue;
    c[r.status] = (c[r.status] || 0) + r.n;
    c.total += r.n;
  }
  return a;
}

/**
 * Reminder-performance digest to the doctor. Built from two reminderStats()
 * outputs (7-day + 30-day windows). Delivery numbers come from the Meta status
 * webhook, so "delivered/read" means the WhatsApp reminder actually reached the
 * patient's phone — not just that Meta accepted it.
 *
 * @param {Object}  opts
 * @param {string}  opts.to        recipient
 * @param {Object}  opts.stats7    reminderStats(7)
 * @param {Object}  opts.stats30   reminderStats(30)
 * @param {Object} [opts.todayRun] this run's summary.counts — adds a "this
 *                                 morning" heartbeat block (omit for on-demand
 *                                 tests with no cron run). When present the
 *                                 email is framed daily; otherwise it reads as
 *                                 a rolling report.
 * @param {string} [opts.runDate]  IST date of the run (YYYY-MM-DD), for labels.
 * @param {Array}  [opts.failures] patients NOT reached on WhatsApp this run —
 *                                 [{ name, phone, type, reason, reachedByEmail }].
 *                                 Renders a "couldn't reach — fix the number"
 *                                 block and drives the subject's failed count.
 * @param {Array}  [opts.sent]     patients the reminder reached this run —
 *                                 [{ name, kind, email }]. Renders the green
 *                                 "reminders sent to" name list.
 */
export async function sendReminderDigestEmail({ to, stats7, stats30, todayRun, runDate, failures, sent }) {
  const pct = (num, den) => (den > 0 ? Math.round((num / den) * 100) : 0);
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const w = aggregateDelivery(stats7.delivery).whatsapp;
  const e = aggregateDelivery(stats7.delivery).email;
  const reached = w.delivered + w.read;          // read implies delivered
  const c7 = stats7.conversion || { reminded_patients: 0, booked_after_reminder: 0 };
  const c30 = stats30.conversion || { reminded_patients: 0, booked_after_reminder: 0 };

  const totalSends = w.total + e.total;
  const reachedPct = pct(reached, w.total);
  const bookedPct7 = pct(c7.booked_after_reminder, c7.reminded_patients);
  const bookedPct30 = pct(c30.booked_after_reminder, c30.reminded_patients);

  // "This morning" heartbeat, straight from the cron's own tally (no DB read).
  const patientsToday = todayRun ? (todayRun.followups || 0) + (todayRun.appointments || 0) : null;
  // Prefer the explicit failure list (patients not reached on WhatsApp) for the
  // count; fall back to the aggregate counters when only todayRun is provided.
  const failList = Array.isArray(failures) ? failures : [];
  const sentList = Array.isArray(sent) ? sent : [];
  const failToday = Array.isArray(failures)
    ? failList.length
    : (todayRun ? (todayRun.whatsapp_fail || 0) + (todayRun.email_fail || 0) : 0);

  // Zero-reach alert: patients were due this morning but NONE got through on any
  // channel — the loudest signal that the cron/Meta/SMTP is broken.
  const dueToday = todayRun ? (todayRun.followups || 0) + (todayRun.appointments || 0) : 0;
  const reachedToday = todayRun ? (todayRun.whatsapp_ok || 0) + (todayRun.email_ok || 0) : 0;
  const zeroSendAlert = !!todayRun && dueToday > 0 && reachedToday === 0;
  const dateLabel = runDate
    ? new Date(`${runDate}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    : '';

  const subject = zeroSendAlert
    ? `🚨 REMINDERS FAILED: ${dueToday} patient(s) due, 0 reached`
    : todayRun
      ? `${failToday > 0 ? '⚠️' : '✅'} Reminders this morning: ${patientsToday} patient(s), ${failToday} failed · ${bookedPct30}% booked (30d)`
      : `Reminder report · last 7 days · ${totalSends} sent, ${c7.booked_after_reminder}/${c7.reminded_patients} patients booked`;

  const row = (label, value, note = '') =>
    `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee;color:#555">${label}</td>` +
    `<td style="padding:6px 12px;border-bottom:1px solid #eee;font-weight:600;color:#111">${value}</td>` +
    `<td style="padding:6px 12px;border-bottom:1px solid #eee;color:#888;font-size:13px">${note}</td></tr>`;

  const todayBlock = todayRun ? `
    <div style="background:${failToday > 0 ? '#fff5f5' : '#f1fbf6'};border:1px solid ${failToday > 0 ? '#f3c2c2' : '#bfe9d2'};border-radius:8px;padding:12px 14px;margin:0 0 18px">
      <div style="font-weight:700;color:${failToday > 0 ? '#c0392b' : '#0b6'};margin-bottom:6px">
        ${failToday > 0 ? '⚠️' : '✅'} This morning's run${dateLabel ? ` · ${dateLabel}` : ''}
      </div>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        ${row('Patients reminded', patientsToday, `${todayRun.followups || 0} follow-up · ${todayRun.appointments || 0} appointment`)}
        ${row('WhatsApp', `${todayRun.whatsapp_ok || 0} sent`, `${todayRun.whatsapp_fail || 0} failed`)}
        ${row('Email', `${todayRun.email_ok || 0} sent`, `${todayRun.email_fail || 0} failed`)}
      </table>
      <div style="color:#888;font-size:12px;margin-top:6px">Delivery receipts for this batch arrive over the next few minutes — see the 7-day delivery below for settled numbers.</div>
    </div>` : '';

  // Patients we couldn't reach on WhatsApp this run — the actionable "fix the
  // number" list. Each row: name · the number that failed · reason · whether
  // email still reached them.
  const failuresBlock = (failList.length) ? `
    <div style="background:#fff5f5;border:1px solid #f3c2c2;border-radius:8px;padding:12px 14px;margin:0 0 18px">
      <div style="font-weight:700;color:#c0392b;margin-bottom:6px">⚠️ Couldn't reach on WhatsApp (${failList.length}) — check the number</div>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        ${failList.map((f) => `<tr>` +
          `<td style="padding:6px 12px;border-bottom:1px solid #f3dada;font-weight:600;color:#111">${escapeHtml(f.name || 'Unknown')}</td>` +
          `<td style="padding:6px 12px;border-bottom:1px solid #f3dada;color:#555">${escapeHtml(f.phone || 'no phone on file')}</td>` +
          `<td style="padding:6px 12px;border-bottom:1px solid #f3dada;color:#888;font-size:13px">${escapeHtml(f.reason || 'send failed')}${f.reachedByEmail ? ' · email sent ✓' : ' · <b style="color:#c0392b">not reached</b>'}</td>` +
          `</tr>`).join('')}
      </table>
    </div>` : '';

  // Loud red banner when nobody was reached despite patients being due.
  const alertBanner = zeroSendAlert ? `
    <div style="background:#c0392b;color:#fff;border-radius:8px;padding:14px 16px;margin:0 0 18px;font-weight:700;line-height:1.5">
      🚨 ${dueToday} patient(s) were due a reminder this morning but NONE were reached on any channel.
      The reminder system may be down — check that the cron ran, the Meta token is valid, and email is working.
    </div>` : '';

  // The names the doctor asked for: who the reminder actually went out to.
  const sentBlock = (sentList.length) ? `
    <div style="background:#f1fbf6;border:1px solid #bfe9d2;border-radius:8px;padding:12px 14px;margin:0 0 18px">
      <div style="font-weight:700;color:#0b6;margin-bottom:6px">✅ Reminders sent to (${sentList.length})</div>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        ${sentList.map((s) => `<tr>` +
          `<td style="padding:5px 12px;border-bottom:1px solid #d9f0e3;font-weight:600;color:#111">${escapeHtml(s.name || 'Unknown')}</td>` +
          `<td style="padding:5px 12px;border-bottom:1px solid #d9f0e3;color:#888;font-size:13px">${escapeHtml(s.kind || 'follow-up')} · WhatsApp${s.email ? ' + email' : ''}</td>` +
          `</tr>`).join('')}
      </table>
    </div>` : '';

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#222">
    <h2 style="margin:0 0 4px;color:#0b6">Follow-up Reminder Report</h2>
    <p style="margin:0 0 18px;color:#888;font-size:14px">WhatsApp + email · Dr. Sujeeth's Healthcare</p>

    ${alertBanner}
    ${todayBlock}
    ${sentBlock}
    ${failuresBlock}

    <h3 style="margin:18px 0 6px;color:#333">📤 Delivery — last 7 days</h3>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      ${row('WhatsApp reminders sent', w.total, 'accepted by WhatsApp')}
      ${row('→ Delivered to phone', reached, `${reachedPct}% of sent`)}
      ${row('→ Read by patient', w.read, w.total ? `${pct(w.read, w.total)}% of sent` : '')}
      ${row('→ Failed / bounced', w.failed, w.failed ? '⚠ check numbers' : 'none')}
      ${row('→ Awaiting delivery receipt', w.sent, w.sent ? 'no WhatsApp / pending' : 'none')}
      ${row('Email reminders sent', e.total, 'parallel safety net')}
    </table>

    <h3 style="margin:22px 0 6px;color:#333">📈 Booking conversion</h3>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      ${row('Patients reminded (7d)', c7.reminded_patients, '')}
      ${row('→ Booked after reminder', c7.booked_after_reminder, `${bookedPct7}% conversion`)}
      ${row('Patients reminded (30d)', c30.reminded_patients, '')}
      ${row('→ Booked after reminder', c30.booked_after_reminder, `${bookedPct30}% conversion`)}
    </table>

    <p style="margin:22px 0 4px;color:#888;font-size:12px;line-height:1.5">
      "Delivered/read" is confirmed by WhatsApp's own receipts. "Booked" = the patient
      created an appointment after the reminder went out. Conversion moves slowly day-to-day —
      the headline above is the daily heartbeat; the tables are rolling context. Data accumulates
      from 16 Jun 2026. Reply to this email to change the schedule or stop it.
    </p>
  </div>`;

  const text =
    `Follow-up Reminder Report\n\n` +
    (zeroSendAlert ? `*** ALERT: ${dueToday} patient(s) due but 0 reached on ANY channel — system may be down ***\n\n` : '') +
    (todayRun
      ? `THIS MORNING${dateLabel ? ` (${dateLabel})` : ''}\n` +
        `  Patients reminded: ${patientsToday} (${todayRun.followups || 0} follow-up, ${todayRun.appointments || 0} appointment)\n` +
        `  WhatsApp: ${todayRun.whatsapp_ok || 0} sent, ${todayRun.whatsapp_fail || 0} failed\n` +
        `  Email: ${todayRun.email_ok || 0} sent, ${todayRun.email_fail || 0} failed\n\n`
      : '') +
    (sentList.length
      ? `REMINDERS SENT TO (${sentList.length})\n` +
        sentList.map((s) => `  ${s.name || 'Unknown'} — ${s.kind || 'follow-up'} · WhatsApp${s.email ? ' + email' : ''}`).join('\n') +
        `\n\n`
      : '') +
    (failList.length
      ? `COULDN'T REACH ON WHATSAPP (${failList.length})\n` +
        failList.map((f) => `  ${f.name || 'Unknown'} · ${f.phone || 'no phone'} · ${f.reason || 'send failed'}${f.reachedByEmail ? ' (email sent)' : ' (NOT REACHED)'}`).join('\n') +
        `\n\n`
      : '') +
    `DELIVERY (last 7 days)\n` +
    `  WhatsApp sent: ${w.total}\n` +
    `  Delivered to phone: ${reached} (${reachedPct}%)\n` +
    `  Read: ${w.read}\n` +
    `  Failed: ${w.failed}\n` +
    `  Awaiting receipt: ${w.sent}\n` +
    `  Email sent: ${e.total}\n\n` +
    `CONVERSION\n` +
    `  7d: ${c7.booked_after_reminder}/${c7.reminded_patients} booked (${bookedPct7}%)\n` +
    `  30d: ${c30.booked_after_reminder}/${c30.reminded_patients} booked (${bookedPct30}%)\n`;

  // Send FROM the real Gmail account (not the drsujeeth.com alias). Two reasons:
  // (1) the digest now goes to a DIFFERENT address (the work inbox), so it's no
  // longer a self-send that Gmail auto-marks read with no notification; (2) a
  // gmail.com From keeps SPF/DKIM/DMARC aligned → inbox, not spam.
  const from = `Dr. Sujeeth's Clinic (reminders) <${process.env.GMAIL_USER || 'dr.sujeeth09@gmail.com'}>`;
  return sendEmail({ to, subject, html, text, from });
}
