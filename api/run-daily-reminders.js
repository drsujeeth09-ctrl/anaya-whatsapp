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
  insertReminderLog,
  reminderStats,
} from '../lib/db.js';
import {
  todayInIST,
  addDaysISO,
  formatDateLong,
} from '../lib/india-holidays.js';
import { sendMetaTemplate, cleanPhone, normalizeIndianWa } from '../lib/meta.js';
import {
  sendFollowUpReminderEmail,
  sendAppointmentReminderEmail,
  sendReminderDigestEmail,
} from '../lib/email.js';

const META_TOKEN = process.env.META_WHATSAPP_TOKEN;

// Language routing (Patient.preferredLanguage: 'en' | 'te' | 'hi', default 'en').
//   langOf    — the row's language (anything unexpected falls back to 'en').
//   tplLang   — a TEMPLATE's registered language, derived from its name
//               suffix. Sends must always pass the template's OWN language
//               code (never the row's) so a te/hi row falling back to an _en
//               template still matches what Meta has approved.
//   nameParam — {{1}} body param. te/hi template bodies already carry the
//               honorific (గారు / जी) so they get the BARE first name; only
//               _en templates get " garu" appended (otherwise a te row would
//               read "గారు garu" — double honorific).
const langOf = (row) => ['te', 'hi'].includes(row.preferred_language) ? row.preferred_language : 'en';
const tplLang = (tpl) => tpl.endsWith('_te') ? 'te' : tpl.endsWith('_hi') ? 'hi' : 'en';
const nameParam = (firstName, lang) =>
  lang === 'en' ? (firstName ? `${firstName} garu` : 'there') : (firstName || 'there');

export default async function handler(req, res) {
  const wantsStats = req.query?.stats === '1' || req.query?.stats === 'true';
  const auth = req.headers['authorization'] || req.headers['Authorization'];
  const authed = auth === `Bearer ${process.env.CRON_SECRET}`;

  // Health check — an UNAUTHENTICATED GET with no stats param (a browser / probe).
  // ⚠ CRITICAL: Vercel Cron triggers this endpoint with an HTTP **GET** request
  // that carries the CRON_SECRET as a Bearer token (per Vercel docs + the
  // `vercel-cron/1.0` user agent). So an *authenticated* GET MUST fall through
  // to the real run below — if we returned the banner for every GET (the old
  // bug), the daily cron just echoed this banner and sent nothing, which is why
  // reminders never went out on schedule.
  if (req.method === 'GET' && !wantsStats && !authed) {
    return res.status(200).json({
      ok: true,
      service: 'anaya-daily-reminders',
      tip: 'POST or authenticated GET with Authorization: Bearer $CRON_SECRET to run; add ?stats=1&days=30 for delivery+conversion stats',
      schedule: '30 3 * * * UTC (09:00 IST daily)',
    });
  }

  // Auth gate (covers the authenticated GET from Vercel Cron AND manual POSTs)
  if (!authed) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Stats reader — delivery funnel + booking conversion from reminder_logs.
  //   GET|POST /api/run-daily-reminders?stats=1&days=30   (needs CRON_SECRET)
  // Returns without running the cron (and without needing META_TOKEN).
  if (wantsStats) {
    const days = Math.min(365, Math.max(1, parseInt(req.query?.days || '30', 10) || 30));
    try {
      return res.status(200).json(await reminderStats(days));
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Force-send the weekly digest email NOW (verification / on-demand), without
  // running the cron or messaging any patient:
  //   POST /api/run-daily-reminders?digest=test   (needs CRON_SECRET)
  if (req.query?.digest === 'test') {
    try {
      const [stats7, stats30] = await Promise.all([reminderStats(7), reminderStats(30)]);
      const to = process.env.REMINDER_DIGEST_TO || 'drsujeeth@drsujeeth.com';
      // ?digest=test&demo=1 injects a sample run + one sample failed patient so
      // the full daily format (heartbeat + "couldn't reach" block) can be
      // previewed without waiting for a real send/failure.
      const demo = req.query?.demo === '1';
      const alertDemo = req.query?.alert === '1'; // demo the zero-reach alert
      const opts = alertDemo
        ? {
            todayRun: { followups: 2, appointments: 0, whatsapp_ok: 0, whatsapp_fail: 2, email_ok: 0, email_fail: 0 },
            runDate: todayInIST(),
            sent: [],
            failures: [
              { name: 'Ramesh Kumar (demo)', phone: '9100000001', type: 'followup_t0', reason: 'Invalid phone number (#131026)', reachedByEmail: false },
              { name: 'Lakshmi Devi (demo)', phone: '9100000002', type: 'followup_t2', reason: 'no phone on file', reachedByEmail: false },
            ],
          }
        : demo
        ? {
            todayRun: { followups: 3, appointments: 0, whatsapp_ok: 2, whatsapp_fail: 1, email_ok: 2, email_fail: 0 },
            runDate: todayInIST(),
            sent: [
              { name: 'Ramesh Kumar (demo)', kind: 'follow-up', email: true },
              { name: 'Lakshmi Devi (demo)', kind: 'follow-up', email: false },
            ],
            failures: [{ name: 'Sample Patient (demo)', phone: '9100000000', type: 'followup_t0', reason: 'Invalid phone number (#131026)', reachedByEmail: true }],
          }
        : {};
      const info = await sendReminderDigestEmail({ to, stats7, stats30, ...opts });
      const out = { ok: true, demo, digestSentTo: to, messageId: info?.messageId };
      // ?digest=test&wa=1 also fires the doctor's WhatsApp summary (real send to
      // his number) so the template can be verified once Meta approves it.
      if (req.query?.wa === '1') {
        const waRes = await sendDoctorWa({ remindedNames: ['Ramesh Kumar', 'Lakshmi Devi', 'Mythili'], notReachedNames: ['Sai Kumar'], stats30, dateLong: formatDateLong(todayInIST()) });
        out.whatsapp = waRes.success ? { ok: true, wamid: waRes.wamid, to: doctorWaTo(), template: waRes.template } : { ok: false, error: waRes.error, template: waRes.template };
      }
      return res.status(200).json(out);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
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

  // Persist each send to reminder_logs so we can later prove delivery (via the
  // Meta status webhook) and measure booking conversion. Best-effort and
  // no-op in dry-run — a logging failure must never break a reminder.
  const logSend = dryRun
    ? async () => {}
    : async (rowData) => {
        try { await insertReminderLog(rowData); }
        catch (e) { console.error('[reminderlog] insert failed:', e?.message); }
      };

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

  // Patients NOT reached on WhatsApp this run (name + the number that failed +
  // reason). Drives the digest's "couldn't reach — fix the number" block. Kept
  // OUT of the returned summary so phone numbers don't land in Vercel logs.
  const failuresToday = [];
  // Patients the reminder WAS delivered to (WhatsApp accepted) — name + which
  // channels + visit kind. Drives the digest's "reminders sent to" name list.
  const sentToday = [];

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
    // Which cohort produced this row — recorded on the reminder log.
    const reminderType = fuBackfillDays
      ? 'followup_backfill'
      : dateISO === today ? 'followup_t0' : dateISO === t2 ? 'followup_t2' : 'followup';
    const result = {
      patient_id: row.patient_id,
      first_name: row.first_name,
      preferred_language: row.preferred_language,
      followup_date: dateISO,
      sends: {},
    };

    // WhatsApp — followup_reminder_2d_<lang> first, then the always-approved
    // English template as a safety net (skipped when the row IS English).
    // Each attempt sends the template's OWN language code + matching {{1}}
    // name param (see tplLang/nameParam at top).
    if (patient.phone) {
      const phone = normalizeIndianWa(patient.phone);
      const lang = langOf(row);
      const chain = lang === 'en'
        ? ['followup_reminder_2d_en']
        : [`followup_reminder_2d_${lang}`, 'followup_reminder_2d_en'];
      let wa = null;
      let usedTemplate = null;
      let usedParameters = null;
      const attemptErrors = [];
      for (const tpl of chain) {
        usedTemplate = tpl;
        const attemptLang = tplLang(tpl);
        usedParameters = [
          { type: 'text', text: nameParam(patient.firstName, attemptLang) },
          { type: 'text', text: dateLong },
        ];
        wa = await sendWA({
          token: META_TOKEN,
          to: phone,
          template: tpl,
          language: attemptLang,
          parameters: usedParameters,
        });
        if (wa.success) break;
        attemptErrors.push({ template: tpl, error: wa.error });
      }
      if (!wa.success) wa = { ...wa, error: { attempts: attemptErrors } };
      result.sends.whatsapp = wa.success
        ? { ok: true, wamid: wa.wamid, template: usedTemplate }
        : { ok: false, error: wa.error, template: usedTemplate };
      if (dryRun) {
        // Echo the selection so ?dryRun=1 proves language routing.
        result.sends.whatsapp.language = tplLang(usedTemplate);
        result.sends.whatsapp.parameters = usedParameters;
      }
      summary.counts[wa.success ? 'whatsapp_ok' : 'whatsapp_fail']++;
      await logSend({
        reminderType,
        channel: 'whatsapp',
        patientId: patient.id,
        consultationId: row.consultation_id,
        recipient: phone,
        template: usedTemplate,
        language: tplLang(usedTemplate),
        dueDate: `${dateISO}T00:00:00Z`,
        status: wa.success ? 'sent' : 'failed',
        providerMessageId: wa.success ? wa.wamid : null,
        errorMessage: wa.success ? null : JSON.stringify(wa.error),
      });
    } else {
      result.sends.whatsapp = { ok: false, error: 'no phone on file' };
      summary.counts.whatsapp_fail++;
      await logSend({
        reminderType, channel: 'whatsapp', patientId: patient.id,
        consultationId: row.consultation_id, dueDate: `${dateISO}T00:00:00Z`,
        status: 'failed', errorMessage: 'no phone on file',
      });
    }

    // Email (parallel channel — sent regardless of WhatsApp result)
    if (patient.email) {
      try {
        const em = await sendFuEmail(patient, dateISO);
        result.sends.email = { ok: true, messageId: em.messageId };
        summary.counts.email_ok++;
        await logSend({
          reminderType, channel: 'email', patientId: patient.id,
          consultationId: row.consultation_id, recipient: patient.email,
          language: langOf(row), dueDate: `${dateISO}T00:00:00Z`,
          status: 'sent', providerMessageId: em.messageId,
        });
      } catch (e) {
        result.sends.email = { ok: false, error: e.message };
        summary.counts.email_fail++;
        await logSend({
          reminderType, channel: 'email', patientId: patient.id,
          consultationId: row.consultation_id, recipient: patient.email,
          dueDate: `${dateISO}T00:00:00Z`, status: 'failed', errorMessage: e.message,
        });
      }
    } else {
      result.sends.email = { ok: false, error: 'no email on file' };
    }

    if (!result.sends.whatsapp.ok) {
      failuresToday.push({
        name: [row.first_name, row.last_name].filter(Boolean).join(' '),
        phone: patient.phone || null,
        type: reminderType,
        reason: shortWaReason(result.sends.whatsapp.error),
        reachedByEmail: !!result.sends.email?.ok,
      });
    } else {
      sentToday.push({
        name: [row.first_name, row.last_name].filter(Boolean).join(' '),
        kind: 'follow-up',
        email: !!result.sends.email?.ok,
      });
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
      preferred_language: row.preferred_language,
      date: tomorrow,
      time,
      sends: {},
    };

    // WhatsApp — visit-type- AND language-aware template:
    //   TELECONSULT with a parseable https://meet.google.com/<code> link →
    //     appointment_reminder_online_<lang> (dynamic Join-video-call URL button);
    //   everything else (IN_CLINIC / FOLLOW_UP, or teleconsult without a
    //     usable link) → appointment_reminder_inclinic_<lang>.
    if (patient.phone) {
      const meetCode = parseMeetCode(row.meet_link);
      const isOnline = row.appt_type === 'TELECONSULT' && !!meetCode;
      const lang = langOf(row);
      // Template chain: try each in order until one sends.
      //   en rows — online_v2_en is a byte-identical duplicate of online_en
      //     submitted 2026-06-11 night because online_en got stuck in a slow
      //     review lane while its te/hi twins approved in minutes — whichever
      //     clears first wins, no deploy needed.
      //   te/hi rows — visit-type template in the patient's language, then
      //     the approved generic 24h_<lang>, then 24h_en as last resort.
      //   The legacy 24h templates carry no meet-link button, so the URL
      //   param is dropped there. Each attempt sends the template's OWN
      //   language code + matching {{1}} name param (see tplLang/nameParam
      //   at top) so cross-language fallbacks still match Meta's registry.
      const chain = isOnline
        ? (lang === 'en'
            ? ['appointment_reminder_online_en', 'appointment_reminder_online_v2_en', 'appointment_reminder_24h_en']
            : [`appointment_reminder_online_${lang}`, `appointment_reminder_24h_${lang}`, 'appointment_reminder_24h_en'])
        : (lang === 'en'
            ? ['appointment_reminder_inclinic_en', 'appointment_reminder_24h_en']
            : [`appointment_reminder_inclinic_${lang}`, `appointment_reminder_24h_${lang}`, 'appointment_reminder_24h_en']);
      let wa = null;
      let usedTemplate = null;
      let usedParameters = null;
      const attemptErrors = [];
      for (const tpl of chain) {
        usedTemplate = tpl;
        const attemptLang = tplLang(tpl);
        usedParameters = [
          { type: 'text', text: nameParam(patient.firstName, attemptLang) },
          { type: 'text', text: dateLong },
          { type: 'text', text: time },
        ];
        const carriesMeetButton = isOnline && tpl.startsWith('appointment_reminder_online');
        wa = await sendWA({
          token: META_TOKEN,
          to: normalizeIndianWa(patient.phone),
          template: tpl,
          language: attemptLang,
          parameters: usedParameters,
          ...(carriesMeetButton ? { buttonUrlParam: meetCode } : {}),
        });
        if (wa.success) break;
        attemptErrors.push({ template: tpl, error: wa.error });
      }
      if (!wa.success) wa = { ...wa, error: { attempts: attemptErrors } };
      result.sends.whatsapp = wa.success
        ? { ok: true, wamid: wa.wamid, template: usedTemplate }
        : { ok: false, error: wa.error, template: usedTemplate };
      if (dryRun) {
        // Echo the selection so ?dryRun=1 verifies routing without sending.
        result.sends.whatsapp.language = tplLang(usedTemplate);
        result.sends.whatsapp.parameters = usedParameters;
        if (isOnline) result.sends.whatsapp.buttonUrlParam = meetCode;
      }
      summary.counts[wa.success ? 'whatsapp_ok' : 'whatsapp_fail']++;
      await logSend({
        reminderType: 'appointment_24h',
        channel: 'whatsapp',
        patientId: patient.id,
        appointmentId: row.appointment_id,
        recipient: normalizeIndianWa(patient.phone),
        template: usedTemplate,
        language: tplLang(usedTemplate),
        dueDate: `${tomorrow}T00:00:00Z`,
        status: wa.success ? 'sent' : 'failed',
        providerMessageId: wa.success ? wa.wamid : null,
        errorMessage: wa.success ? null : JSON.stringify(wa.error),
      });
    } else {
      result.sends.whatsapp = { ok: false, error: 'no phone on file' };
      summary.counts.whatsapp_fail++;
      await logSend({
        reminderType: 'appointment_24h', channel: 'whatsapp', patientId: patient.id,
        appointmentId: row.appointment_id, dueDate: `${tomorrow}T00:00:00Z`,
        status: 'failed', errorMessage: 'no phone on file',
      });
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
        await logSend({
          reminderType: 'appointment_24h', channel: 'email', patientId: patient.id,
          appointmentId: row.appointment_id, recipient: patient.email,
          language: langOf(row), dueDate: `${tomorrow}T00:00:00Z`,
          status: 'sent', providerMessageId: em.messageId,
        });
      } catch (e) {
        result.sends.email = { ok: false, error: e.message };
        summary.counts.email_fail++;
        await logSend({
          reminderType: 'appointment_24h', channel: 'email', patientId: patient.id,
          appointmentId: row.appointment_id, recipient: patient.email,
          dueDate: `${tomorrow}T00:00:00Z`, status: 'failed', errorMessage: e.message,
        });
      }
    } else {
      result.sends.email = { ok: false, error: 'no email on file' };
    }

    if (!result.sends.whatsapp.ok) {
      failuresToday.push({
        name: [row.first_name, row.last_name].filter(Boolean).join(' '),
        phone: patient.phone || null,
        type: 'appointment_24h',
        reason: shortWaReason(result.sends.whatsapp.error),
        reachedByEmail: !!result.sends.email?.ok,
      });
    } else {
      sentToday.push({
        name: [row.first_name, row.last_name].filter(Boolean).join(' '),
        kind: 'appointment',
        email: !!result.sends.email?.ok,
      });
    }

    summary.appointments.push(result);
  }

  // -------------------------------------------------------------------------
  // 3. Email digest — piggybacks on this daily cron (Hobby caps us at 2 crons
  //    + 12 functions, so no separate schedule/endpoint is possible). The
  //    scheduled run also emails the doctor a "this morning" heartbeat +
  //    rolling delivery/conversion summary. DAILY by default (doctor's
  //    preference); set REMINDER_DIGEST_DOW to a weekday (0=Sun..6=Sat) to
  //    switch back to once-weekly. Skipped during dryRun and backfill runs.
  // -------------------------------------------------------------------------
  {
    const dowEnv = parseInt(process.env.REMINDER_DIGEST_DOW, 10);
    const restrictDow = Number.isInteger(dowEnv) && dowEnv >= 0 && dowEnv <= 6;
    const todayDow = new Date(`${today}T00:00:00Z`).getUTCDay();
    const isDigestDay = !restrictDow || todayDow === dowEnv;
    if (!fuBackfillDays && isDigestDay) {
      if (dryRun) {
        summary.digest = { wouldSend: true, cadence: restrictDow ? 'weekly' : 'daily' };
      } else {
        try {
          const [stats7, stats30] = await Promise.all([reminderStats(7), reminderStats(30)]);
          const to = process.env.REMINDER_DIGEST_TO || 'drsujeeth@drsujeeth.com';
          const info = await sendReminderDigestEmail({ to, stats7, stats30, todayRun: summary.counts, runDate: today, failures: failuresToday, sent: sentToday });
          summary.digest = { sent: true, to, messageId: info?.messageId };
          // Heartbeat to the doctor's WhatsApp (reliable notification channel).
          // reached = got at least one channel; notReached = reached on nothing.
          try {
            // reached = got at least one channel; notReached = reached on nothing.
            const remindedNames = [
              ...sentToday.map((s) => s.name),
              ...failuresToday.filter((f) => f.reachedByEmail).map((f) => f.name),
            ];
            const notReachedNames = failuresToday.filter((f) => !f.reachedByEmail).map((f) => f.name);
            const waRes = await sendDoctorWa({ remindedNames, notReachedNames, stats30, dateLong: formatDateLong(today) });
            summary.digest.whatsapp = waRes.success ? { ok: true, wamid: waRes.wamid, template: waRes.template } : { ok: false, error: waRes.error, template: waRes.template };
          } catch (e2) {
            summary.digest.whatsapp = { ok: false, error: e2.message };
            console.error('[digest] whatsapp failed:', e2?.message);
          }
        } catch (e) {
          summary.digest = { sent: false, error: e.message };
          console.error('[digest] failed:', e?.message);
        }
      }
    } else {
      summary.digest = { sent: false, reason: fuBackfillDays ? 'backfill run' : `restricted to dow=${dowEnv}, today=${todayDow}` };
    }
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

// --- Doctor's daily WhatsApp heartbeat (template daily_reminder_summary_en) ---
// Email digests reach the doctor as self-sends Gmail auto-marks read with no
// notification, so the same summary also goes to his WhatsApp (the channel he
// reliably gets notified on). Best-effort — never blocks the cron.
function doctorWaTo() { return process.env.REMINDER_WA_TO || '919866134340'; }
function convString(stats30) {
  const conv = stats30?.conversion || { reminded_patients: 0, booked_after_reminder: 0 };
  return conv.reminded_patients > 0
    ? `${Math.round((conv.booked_after_reminder / conv.reminded_patients) * 100)}% (${conv.booked_after_reminder} of ${conv.reminded_patients})`
    : 'no data yet';
}
// WhatsApp-param-safe comma list of names: collapse whitespace (Meta rejects
// params with newlines/tabs/4+ spaces), cap ~320 chars → "+N more", "none" empty.
function nameList(names) {
  const clean = (names || []).map((n) => String(n || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!clean.length) return 'none';
  const out = [];
  let len = 0;
  for (let i = 0; i < clean.length; i++) {
    if (len + clean[i].length + 2 > 320) { out.push(`+${clean.length - i} more`); break; }
    out.push(clean[i]);
    len += clean[i].length + 2;
  }
  return out.join(', ');
}
// Send the doctor's heartbeat: v2 template (WITH patient names) first, falling
// back to the v1 counts-only template while v2 is still in Meta review (so the
// daily WhatsApp is never dark). Returns { success, wamid?, template, error? }.
async function sendDoctorWa({ remindedNames, notReachedNames, stats30, dateLong }) {
  const reached = (remindedNames || []).length;
  const notReached = (notReachedNames || []).length;
  const conv = convString(stats30);
  // v3 = UTILITY, with patient NAMES (no conversion line — that business metric
  // got the earlier v2 reclassified MARKETING). Falls back to v1 UTILITY counts
  // while v3 is still in review, so the daily WhatsApp is never dark.
  const attempts = [
    { template: 'daily_reminder_report_v3_en', parameters: [
      { type: 'text', text: dateLong }, { type: 'text', text: String(reached) }, { type: 'text', text: nameList(remindedNames) },
      { type: 'text', text: String(notReached) }, { type: 'text', text: nameList(notReachedNames) } ] },
    { template: 'daily_reminder_summary_en', parameters: [
      { type: 'text', text: dateLong }, { type: 'text', text: String(reached) }, { type: 'text', text: String(notReached) }, { type: 'text', text: conv } ] },
  ];
  let res = { success: false };
  for (const a of attempts) {
    res = await sendMetaTemplate({ token: process.env.META_WHATSAPP_TOKEN, to: doctorWaTo(), template: a.template, language: 'en', parameters: a.parameters });
    res.template = a.template;
    if (res.success) break;
  }
  return res;
}

// Pull a short, human-readable reason out of a WhatsApp send error so the
// digest can show "Invalid phone number (#131026)" instead of a raw blob.
// Handles the cron's chain-failure shape { attempts: [{template, error}] } plus
// Meta's nested { error: { message, code, error_data: { details } } }, and the
// plain-string case ("no phone on file").
function shortWaReason(err) {
  if (!err) return 'send failed';
  if (typeof err === 'string') return err;
  let e = err;
  if (Array.isArray(err.attempts) && err.attempts.length) {
    e = err.attempts[err.attempts.length - 1]?.error;
  }
  const meta = e?.error || e?.data?.error || e;
  const msg = meta?.error_data?.details || meta?.message || meta?.error_user_title;
  const code = meta?.code;
  if (msg) return code ? `${msg} (#${code})` : String(msg);
  try { return JSON.stringify(e).slice(0, 140); } catch { return 'send failed'; }
}
