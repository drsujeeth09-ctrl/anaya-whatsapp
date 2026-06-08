// Daily reminder cron — runs once per day at 09:00 IST (03:30 UTC).
//
// Two cohorts handled in one run:
//   1. T-2 follow-up nudge:
//        Patients whose Consultation.followUpDate falls 2 days from today (IST).
//        Fires followup_reminder_2d_<lang> WhatsApp + email in parallel.
//   2. 24-hour appointment reminder:
//        Patients with an Appointment scheduled for tomorrow (IST), status SCHEDULED.
//        Fires appointment_reminder_24h_<lang> WhatsApp + email.
//
// Auth: Vercel cron sends `Authorization: Bearer ${CRON_SECRET}`.  GETs
//       without auth are treated as health checks (returns service banner).
//
// Returns a JSON summary of what was fired so we can audit via Vercel logs.
//
// Schedule:  vercel.json -> "schedule": "30 3 * * *"  (03:30 UTC = 09:00 IST)
//
// See project_followup_reminder_workflow.md for the full design rationale.

import {
  consultationsWithFollowUpOn,
  appointmentsOn,
  formatTimeIST,
} from '../lib/db.js';
import {
  todayInIST,
  addDaysISO,
  formatDateLong,
} from '../lib/india-holidays.js';
import { sendMetaTemplate, cleanPhone } from '../lib/meta.js';
import {
  sendFollowUpReminderEmail,
  sendAppointmentReminderEmail,
} from '../lib/email.js';

const META_TOKEN = process.env.META_WHATSAPP_TOKEN;

export default async function handler(req, res) {
  // Health check — GET without auth.
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'anaya-daily-reminders',
      tip: 'POST with Authorization: Bearer $CRON_SECRET, or let Vercel cron call it on schedule',
      schedule: '30 3 * * * UTC (09:00 IST daily)',
    });
  }

  // Auth gate
  const auth = req.headers['authorization'] || req.headers['Authorization'];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!META_TOKEN) {
    return res.status(500).json({ error: 'META_WHATSAPP_TOKEN not set' });
  }

  // Dry-run: compute cohorts + build the would-send payloads but DON'T call
  // Meta/Gmail. Lets us verify the reminder pipeline without messaging patients.
  //   POST /api/run-daily-reminders?dryRun=1   (still needs CRON_SECRET)
  const dryRun = req.query?.dryRun === '1' || req.query?.dryRun === 'true';
  const sendWA = dryRun
    ? async ({ to, template }) => ({ success: true, wamid: '(dry-run)', to, template })
    : sendMetaTemplate;
  const sendFuEmail = dryRun ? async () => ({ messageId: '(dry-run)' }) : sendFollowUpReminderEmail;
  const sendApptEmail = dryRun ? async () => ({ messageId: '(dry-run)' }) : sendAppointmentReminderEmail;

  const today = todayInIST();
  const t2 = addDaysISO(today, 2);
  const tomorrow = addDaysISO(today, 1);

  const summary = {
    runAt: new Date().toISOString(),
    dryRun,
    today,
    cohorts: { followup_t2: t2, appointments_tomorrow: tomorrow },
    followups: [],
    appointments: [],
    counts: { followups: 0, appointments: 0, whatsapp_ok: 0, whatsapp_fail: 0, email_ok: 0, email_fail: 0 },
  };

  // -------------------------------------------------------------------------
  // 1. T-2 follow-up cohort
  // -------------------------------------------------------------------------
  let followupRows = [];
  try {
    followupRows = await consultationsWithFollowUpOn(t2);
  } catch (e) {
    summary.followups.push({ error: 'db_query_failed', message: e.message });
    return res.status(500).json({ ...summary, fatal: 'db error in followup query' });
  }

  for (const row of followupRows) {
    summary.counts.followups++;
    const patient = {
      id: row.patient_id,
      firstName: row.first_name,
      lastName: row.last_name,
      phone: row.phone,
      email: row.email,
    };
    const dateLong = formatDateLong(t2);
    const result = {
      patient_id: row.patient_id,
      first_name: row.first_name,
      followup_date: t2,
      sends: {},
    };

    // WhatsApp
    if (patient.phone) {
      const phone = cleanPhone(patient.phone);
      const wa = await sendWA({
        token: META_TOKEN,
        to: phone,
        template: 'followup_reminder_2d_en',
        language: 'en',
        parameters: [
          { type: 'text', text: patient.firstName || 'there' },
          { type: 'text', text: dateLong },
        ],
      });
      result.sends.whatsapp = wa.success
        ? { ok: true, wamid: wa.wamid }
        : { ok: false, error: wa.error };
      summary.counts[wa.success ? 'whatsapp_ok' : 'whatsapp_fail']++;
    } else {
      result.sends.whatsapp = { ok: false, error: 'no phone on file' };
      summary.counts.whatsapp_fail++;
    }

    // Email (parallel channel — sent regardless of WhatsApp result)
    if (patient.email) {
      try {
        const em = await sendFuEmail(patient, t2);
        result.sends.email = { ok: true, messageId: em.messageId };
        summary.counts.email_ok++;
      } catch (e) {
        result.sends.email = { ok: false, error: e.message };
        summary.counts.email_fail++;
      }
    } else {
      result.sends.email = { ok: false, error: 'no email on file' };
    }

    summary.followups.push(result);
  }

  // -------------------------------------------------------------------------
  // 2. 24-hour appointment cohort
  // -------------------------------------------------------------------------
  let apptRows = [];
  try {
    apptRows = await appointmentsOn(tomorrow);
  } catch (e) {
    summary.appointments.push({ error: 'db_query_failed', message: e.message });
  }

  for (const row of apptRows) {
    summary.counts.appointments++;
    const patient = {
      id: row.patient_id,
      firstName: row.first_name,
      lastName: row.last_name,
      phone: row.phone,
      email: row.email,
    };
    const dateLong = formatDateLong(tomorrow);
    const time = formatTimeIST(row.start_time);
    const result = {
      patient_id: row.patient_id,
      first_name: row.first_name,
      date: tomorrow,
      time,
      sends: {},
    };

    // WhatsApp
    if (patient.phone) {
      const wa = await sendWA({
        token: META_TOKEN,
        to: cleanPhone(patient.phone),
        template: 'appointment_reminder_24h_en',
        language: 'en',
        parameters: [
          { type: 'text', text: patient.firstName || 'there' },
          { type: 'text', text: dateLong },
          { type: 'text', text: time },
        ],
      });
      result.sends.whatsapp = wa.success
        ? { ok: true, wamid: wa.wamid }
        : { ok: false, error: wa.error };
      summary.counts[wa.success ? 'whatsapp_ok' : 'whatsapp_fail']++;
    } else {
      result.sends.whatsapp = { ok: false, error: 'no phone on file' };
      summary.counts.whatsapp_fail++;
    }

    // Email
    if (patient.email) {
      try {
        const em = await sendApptEmail(patient, tomorrow, time);
        result.sends.email = { ok: true, messageId: em.messageId };
        summary.counts.email_ok++;
      } catch (e) {
        result.sends.email = { ok: false, error: e.message };
        summary.counts.email_fail++;
      }
    } else {
      result.sends.email = { ok: false, error: 'no email on file' };
    }

    summary.appointments.push(result);
  }

  return res.status(200).json(summary);
}
