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
  consultationsWithFollowUpUnbooked,
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
    ? async ({ to, template, parameters, buttonUrlParam }) =>
        ({ success: true, wamid: '(dry-run)', to, template, parameters, buttonUrlParam })
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
  // 1. Follow-up cohort(s)
  //    Normal daily run:
  //      • T-2 first nudge  — every follow-up due in 2 days.
  //      • T-0 day-of nudge — follow-ups due TODAY whose patient still hasn't
  //        booked/returned (2nd-chance reminder; added 2026-06-08).
  //    Backfill mode (?followupBackfillDays=N): one-time catch-up for
  //      follow-ups due in [today-N, tomorrow] whose patient hasn't booked —
  //      recovers nudges the cron missed while it was down 2026-05-27 → 06-08.
  //      Runs ONLY the follow-up cohort (skips the appointment cohort below).
  // -------------------------------------------------------------------------
  const fuBackfillDays = parseInt(req.query?.followupBackfillDays || '', 10) || 0;
  if (fuBackfillDays) summary.cohorts.followupBackfillDays = fuBackfillDays;

  let followupRows = [];
  try {
    if (fuBackfillDays > 0) {
      followupRows = await consultationsWithFollowUpUnbooked(
        addDaysISO(today, -fuBackfillDays),
        addDaysISO(today, 2), // exclusive end → includes tomorrow's due date
      );
    } else {
      const t2rows = await consultationsWithFollowUpOn(t2);
      const t0rows = await consultationsWithFollowUpUnbooked(today, tomorrow);
      followupRows = [...t2rows, ...t0rows];
    }
  } catch (e) {
    summary.followups.push({ error: 'db_query_failed', message: e.message });
    return res.status(500).json({ ...summary, fatal: 'db error in followup query' });
  }

  // One reminder per patient — dedupe keeping the latest follow-up date.
  {
    const byPatient = new Map();
    for (const r of followupRows) {
      const ex = byPatient.get(r.patient_id);
      if (!ex || new Date(r.follow_up_date) > new Date(ex.follow_up_date)) {
        byPatient.set(r.patient_id, r);
      }
    }
    followupRows = [...byPatient.values()];
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
    // Per-row follow-up date (cohorts now span multiple dates).
    const dateISO = new Date(row.follow_up_date).toISOString().slice(0, 10);
    const dateLong = formatDateLong(dateISO);
    const result = {
      patient_id: row.patient_id,
      first_name: row.first_name,
      followup_date: dateISO,
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
          // Template body opens "Hello {{1}}, ..." — append the respectful
          // "garu" honorific when we know the name (doctor's greeting rule).
          { type: 'text', text: patient.firstName ? `${patient.firstName} garu` : 'there' },
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
        const em = await sendFuEmail(patient, dateISO);
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
  // 2. 24-hour appointment cohort  (skipped during a follow-up backfill run)
  // -------------------------------------------------------------------------
  let apptRows = [];
  try {
    apptRows = fuBackfillDays ? [] : await appointmentsOn(tomorrow);
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

    // WhatsApp — visit-type-aware template:
    //   TELECONSULT with a parseable https://meet.google.com/<code> link →
    //     appointment_reminder_online_en (dynamic Join-video-call URL button);
    //   everything else (IN_CLINIC / FOLLOW_UP, or teleconsult without a
    //     usable link) → appointment_reminder_inclinic_en.
    //   Both new templates are PENDING Meta approval (submitted 2026-06-11),
    //   so ANY send failure retries ONCE with the approved generic
    //   appointment_reminder_24h_en using the same 3 body params.
    if (patient.phone) {
      const meetCode = parseMeetCode(row.meet_link);
      const isOnline = row.appt_type === 'TELECONSULT' && !!meetCode;
      const parameters = [
        // Template body opens "Hello {{1}}, ..." — append "garu" when the
        // name is known (doctor's respectful-greeting rule).
        { type: 'text', text: patient.firstName ? `${patient.firstName} garu` : 'there' },
        { type: 'text', text: dateLong },
        { type: 'text', text: time },
      ];
      let usedTemplate = isOnline
        ? 'appointment_reminder_online_en'
        : 'appointment_reminder_inclinic_en';
      let wa = await sendWA({
        token: META_TOKEN,
        to: cleanPhone(patient.phone),
        template: usedTemplate,
        language: 'en',
        parameters,
        ...(isOnline ? { buttonUrlParam: meetCode } : {}),
      });
      if (!wa.success) {
        const primaryError = { template: usedTemplate, error: wa.error };
        usedTemplate = 'appointment_reminder_24h_en';
        wa = await sendWA({
          token: META_TOKEN,
          to: cleanPhone(patient.phone),
          template: usedTemplate,
          language: 'en',
          parameters,
        });
        if (!wa.success) wa = { ...wa, error: { fallback: wa.error, primary: primaryError } };
      }
      result.sends.whatsapp = wa.success
        ? { ok: true, wamid: wa.wamid, template: usedTemplate }
        : { ok: false, error: wa.error, template: usedTemplate };
      if (dryRun) {
        // Echo the selection so ?dryRun=1 verifies routing without sending.
        result.sends.whatsapp.parameters = parameters;
        if (isOnline) result.sends.whatsapp.buttonUrlParam = meetCode;
      }
      summary.counts[wa.success ? 'whatsapp_ok' : 'whatsapp_fail']++;
    } else {
      result.sends.whatsapp = { ok: false, error: 'no phone on file' };
      summary.counts.whatsapp_fail++;
    }

    // Email
    if (patient.email) {
      try {
        const em = await sendApptEmail(patient, tomorrow, time, {
          appointmentType: row.appt_type,
          meetLink: row.meet_link,
        });
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

// Extract the Meet code from a https://meet.google.com/<code> link — the
// online template's URL button only takes the dynamic suffix after the
// domain. Returns null when the link is missing or not a parseable Meet URL
// (caller then falls back to the in-clinic template).
function parseMeetCode(meetLink) {
  const m = /^https:\/\/meet\.google\.com\/([A-Za-z0-9-]+)\/?$/.exec(String(meetLink || '').trim());
  return m ? m[1] : null;
}
