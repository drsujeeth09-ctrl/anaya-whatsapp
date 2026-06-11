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

/** Send a plain email. */
export async function sendEmail({ to, subject, html, text }) {
  const transporter = getTransporter();
  const opts = { from: fromHeader(), to, subject, html };
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
