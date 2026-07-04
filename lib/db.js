// Postgres client for querying the EMR's Supabase database.
//
// Reads DATABASE_URL from env (the same pgbouncer URL the EMR uses).  Uses
// `pg` library directly with parameterized queries — read-only access only.

import pg from 'pg';
import crypto from 'crypto';

let _pool = null;

function getPool() {
  if (_pool) return _pool;
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL not set');
  // Parse manually — passing both `connectionString` and `ssl` to pg leaves
  // the sslmode=require directive in the URL fighting our ssl override.
  // Discrete fields + ssl-only-via-config avoids the conflict.
  const u = new URL(raw);
  _pool = new pg.Pool({
    host: u.hostname,
    port: parseInt(u.port || '5432', 10),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, '') || 'postgres',
    max: 4,
    idleTimeoutMillis: 30_000,
    // Supabase pooler uses a Supabase-CA-signed cert; Node's default trust
    // store rejects it as "self-signed in chain".  We accept it — traffic
    // stays inside Vercel↔Supabase clouds, so MITM risk is minimal.
    ssl: { rejectUnauthorized: false },
  });
  return _pool;
}

/**
 * Query patients whose next follow-up date falls on a specific IST date.
 *
 * @param {string} istDate  YYYY-MM-DD in IST.  We treat the stored
 *                          followUpDate as midnight-UTC of the chosen day
 *                          (which is how Prisma persists a Date) and compare
 *                          against [istDate 00:00 UTC, istDate+1 00:00 UTC).
 * @returns {Promise<Array>}  Array of {consultationId, followUpDate, patientId,
 *                            firstName, lastName, phone, email, preferredLanguage}
 */
export async function consultationsWithFollowUpOn(istDate) {
  const pool = getPool();
  const start = `${istDate}T00:00:00Z`;
  const end = nextDayUtc(istDate);
  const sql = `
    SELECT
      c.id            AS consultation_id,
      c."followUpDate" AS follow_up_date,
      c."followUpInstructions" AS follow_up_instructions,
      p.id            AS patient_id,
      p."firstName"   AS first_name,
      p."lastName"    AS last_name,
      p.phone         AS phone,
      p.email         AS email,
      p."preferredLanguage" AS preferred_language
    FROM "consultations" c
    JOIN "patients" p ON p.id = c."patientId"
    WHERE c."followUpDate" >= $1
      AND c."followUpDate" <  $2
      AND c.status IN ('COMPLETED', 'SIGNED')
    ORDER BY c."followUpDate" ASC
  `;
  const r = await pool.query(sql, [start, end]);
  return r.rows;
}

/**
 * Query appointments scheduled for a specific IST date (for the 24-hour
 * reminder cron, called with tomorrow's IST date).
 */
export async function appointmentsOn(istDate) {
  const pool = getPool();
  // IMPORTANT: the EMR stores Appointment.date as IST-midnight (see the EMR's
  // istMidnight helper): an IST calendar day D is persisted as the UTC instant
  // D 00:00 IST = (D-1) 18:30 UTC. So querying with UTC-midnight boundaries —
  // as consultationsWithFollowUpOn does, because followUpDate IS stored at
  // UTC-midnight — matches the WRONG day here (off by one). Use IST-midnight
  // boundaries so the window lines up with how `date` is actually stored.
  const start = new Date(`${istDate}T00:00:00+05:30`); // IST midnight of istDate
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const sql = `
    SELECT
      a.id            AS appointment_id,
      a.date          AS appt_date,
      a."startTime"   AS start_time,
      a.type          AS appt_type,
      a."meetLink"    AS meet_link,
      a."visitPurpose" AS visit_purpose,
      p.id            AS patient_id,
      p."firstName"   AS first_name,
      p."lastName"    AS last_name,
      p.phone         AS phone,
      p.email         AS email,
      p."preferredLanguage" AS preferred_language
    FROM "appointments" a
    JOIN "patients" p ON p.id = a."patientId"
    WHERE a.date >= $1
      AND a.date <  $2
      AND a.status = 'SCHEDULED'
    ORDER BY a."startTime" ASC
  `;
  const r = await pool.query(sql, [start.toISOString(), end.toISOString()]);
  return r.rows;
}

/**
 * Follow-ups due in [fromISTDate, toISTDate) whose patient has NOT booked or
 * returned. Used for (a) the day-of (T-0) second-chance nudge and (b) the
 * one-time catch-up backfill of nudges the cron missed while it was down.
 *
 * "Not booked / not returned" = no appointment dated on/after the follow-up
 * date (1-day grace absorbs IST-midnight storage + early returns) AND no later
 * consultation (a return visit creates a new Consultation row). followUpDate is
 * stored at UTC-midnight, so plain UTC-midnight boundaries are correct here.
 */
export async function consultationsWithFollowUpUnbooked(fromISTDate, toISTDate) {
  const pool = getPool();
  const start = `${fromISTDate}T00:00:00Z`;
  const end = `${toISTDate}T00:00:00Z`; // exclusive
  const sql = `
    SELECT
      c.id            AS consultation_id,
      c."followUpDate" AS follow_up_date,
      p.id            AS patient_id,
      p."firstName"   AS first_name,
      p."lastName"    AS last_name,
      p.phone         AS phone,
      p.email         AS email,
      p."preferredLanguage" AS preferred_language
    FROM "consultations" c
    JOIN "patients" p ON p.id = c."patientId"
    WHERE c."followUpDate" >= $1
      AND c."followUpDate" <  $2
      AND c.status IN ('COMPLETED', 'SIGNED')
      AND NOT EXISTS (
        SELECT 1 FROM "appointments" a
        WHERE a."patientId" = c."patientId"
          AND a.date >= c."followUpDate" - INTERVAL '1 day'
      )
      AND NOT EXISTS (
        SELECT 1 FROM "consultations" c2
        WHERE c2."patientId" = c."patientId"
          AND c2.id <> c.id
          AND c2."createdAt" >= c."followUpDate" - INTERVAL '1 day'
      )
    ORDER BY c."followUpDate" ASC
  `;
  const r = await pool.query(sql, [start, end]);
  return r.rows;
}

/**
 * For an inbound WhatsApp "check my prescription" request: given the sender's
 * 10-digit number, return how many distinct patients are on that number and —
 * only when exactly ONE is — that patient's name + latest prescription link.
 * The caller auto-resends only when patientCount === 1 (no wrong-patient risk
 * on shared family numbers). Phone is normalised to last-10-digits because the
 * EMR stores numbers inconsistently (spaces, +91, etc.).
 */
export async function prescriptionLookupByPhone(tenDigit) {
  const pool = getPool();
  const NORM = `RIGHT(regexp_replace(p.phone, '[^0-9]', '', 'g'), 10)`;
  const cnt = await pool.query(
    `SELECT COUNT(DISTINCT p.id)::int AS n FROM "patients" p WHERE ${NORM} = $1`,
    [tenDigit],
  );
  const patientCount = cnt.rows[0]?.n || 0;
  let patient = null, publicLinkId = null;
  if (patientCount === 1) {
    const r = await pool.query(
      `SELECT p."firstName", p."lastName", p.salutation, r."publicLinkId"
       FROM "prescriptions" r
       JOIN "patients" p ON p.id = r."patientId"
       WHERE ${NORM} = $1 AND r."publicLinkId" IS NOT NULL
       ORDER BY r."createdAt" DESC
       LIMIT 1`,
      [tenDigit],
    );
    if (r.rows[0]) {
      patient = { firstName: r.rows[0].firstName, lastName: r.rows[0].lastName, salutation: r.rows[0].salutation };
      publicLinkId = r.rows[0].publicLinkId;
    }
  }
  return { patientCount, patient, publicLinkId };
}

/**
 * Upcoming SCHEDULED appointments for whoever is on this phone number —
 * powers the WhatsApp "confirm my appointment time" self-service reply.
 * Includes today's appointments: Appointment.date is stored at IST-midnight
 * (see appointmentsOn), so the window opens at IST-midnight of today.
 * Returns up to `limit` rows across ALL patients on the number (household
 * numbers list each family member's appointment — read-only, no wrong-patient
 * risk since we only STATE what's booked).
 */
export async function upcomingAppointmentsByPhone(tenDigit, limit = 3) {
  const pool = getPool();
  const NORM = `RIGHT(regexp_replace(p.phone, '[^0-9]', '', 'g'), 10)`;
  const istToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const start = new Date(`${istToday}T00:00:00+05:30`);
  const sql = `
    SELECT
      a.id            AS appointment_id,
      a.date          AS appt_date,
      a."startTime"   AS start_time,
      a.type          AS appt_type,
      a."meetLink"    AS meet_link,
      p."firstName"   AS first_name,
      p."lastName"    AS last_name
    FROM "appointments" a
    JOIN "patients" p ON p.id = a."patientId"
    WHERE ${NORM} = $1
      AND a.status = 'SCHEDULED'
      AND a.date >= $2
    ORDER BY a.date ASC, a."startTime" ASC
    LIMIT $3
  `;
  const r = await pool.query(sql, [tenDigit, start.toISOString(), limit]);
  return r.rows;
}

/**
 * When did we last fire an escalation alert about this patient's number?
 * Used by lib/escalation.js to throttle alert bursts (durable across lambda
 * instances — an in-memory throttle wouldn't survive cold starts).
 */
export async function lastEscalationAlertAt(phoneDigits) {
  const pool = getPool();
  const r = await pool.query(
    `SELECT max("sentAt") AS last FROM "reminder_logs"
     WHERE "reminderType" = 'escalation_alert' AND recipient = $1`,
    [phoneDigits],
  );
  return r.rows[0]?.last || null;
}

function nextDayUtc(istDate) {
  const d = new Date(istDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

/** Format a Postgres-returned timestamp into a clock time like "5:30 PM" in IST. */
export function formatTimeIST(ts) {
  if (!ts) return '';
  const d = (ts instanceof Date) ? ts : new Date(ts);
  return d.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

// ===========================================================================
// reminder_logs — delivery + conversion tracking (writes).
//
// Schema is owned by the EMR's Prisma model `ReminderLog` (table reminder_logs).
// We write via raw SQL because anaya doesn't run Prisma. Two caller-side
// quirks the schema forces on us:
//   • `id` has a Prisma-client @default(cuid()) that NEVER fires on raw INSERT,
//     so we generate it here (crypto.randomUUID — any unique text is valid).
//   • `updatedAt` is @updatedAt (client-side, no DB trigger/default), so every
//     raw write MUST set it explicitly or the NOT NULL constraint rejects it.
// ===========================================================================

/**
 * Record one reminder send (WhatsApp or email). Best-effort — the caller must
 * never let a logging failure block the actual reminder. Returns the new row
 * id, or null on failure (caller swallows the throw).
 *
 * @param {Object} row
 * @param {string} row.reminderType  followup_t2 | followup_t0 | followup_backfill | followup | appointment_24h
 * @param {string} row.channel       'whatsapp' | 'email'
 * @param {string} [row.patientId]
 * @param {string} [row.consultationId]
 * @param {string} [row.appointmentId]
 * @param {string} [row.recipient]   phone digits or email
 * @param {string} [row.template]    Meta template name actually sent
 * @param {string} [row.language]    en | te | hi
 * @param {string} [row.dueDate]     ISO timestamp the reminder is about (followUp/appt date)
 * @param {string} [row.status]      'sent' (Meta accepted) | 'failed' (Meta rejected at send)
 * @param {string} [row.providerMessageId]  wamid (whatsapp) or SMTP messageId (email)
 * @param {string} [row.errorMessage]
 */
export async function insertReminderLog(row) {
  const pool = getPool();
  const id = crypto.randomUUID();
  const sql = `
    INSERT INTO "reminder_logs"
      (id, "reminderType", channel, "patientId", "consultationId", "appointmentId",
       recipient, template, language, "dueDate", status, "providerMessageId",
       "errorMessage", "sentAt", "updatedAt")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), now())
    RETURNING id
  `;
  const r = await pool.query(sql, [
    id,
    row.reminderType,
    row.channel,
    row.patientId || null,
    row.consultationId || null,
    row.appointmentId || null,
    row.recipient || null,
    row.template || null,
    row.language || null,
    row.dueDate || null,
    row.status || 'sent',
    row.providerMessageId || null,
    row.errorMessage ? String(row.errorMessage).slice(0, 1000) : null,
  ]);
  return r.rows[0]?.id || null;
}

/**
 * Advance a reminder_logs row's delivery status from a Meta status webhook,
 * keyed by wamid. Status only moves FORWARD (sent < delivered < read; failed
 * always recorded) so out-of-order webhook events can't downgrade a row. Many
 * wamids won't match a reminder (inbound-reply receipts, prescription sends,
 * etc.) — that's expected; returns the number of rows updated (0 = not ours).
 */
export async function updateReminderStatusByWamid(wamid, status, errorMessage) {
  if (!wamid || !status) return 0;
  const pool = getPool();
  const rank = `(CASE %s WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 4 ELSE 0 END)`;
  const sql = `
    UPDATE "reminder_logs"
    SET status = $1,
        "deliveredAt" = CASE WHEN $1 = 'delivered' THEN COALESCE("deliveredAt", now()) ELSE "deliveredAt" END,
        "readAt"      = CASE WHEN $1 = 'read'      THEN COALESCE("readAt", now())      ELSE "readAt" END,
        "failedAt"    = CASE WHEN $1 = 'failed'    THEN COALESCE("failedAt", now())    ELSE "failedAt" END,
        "errorMessage" = COALESCE($2, "errorMessage"),
        "updatedAt"   = now()
    WHERE "providerMessageId" = $3
      AND ${rank.replace('%s', 'status')} <= ${rank.replace('%s', '$1')}
  `;
  const r = await pool.query(sql, [status, errorMessage ? String(errorMessage).slice(0, 500) : null, wamid]);
  return r.rowCount || 0;
}

/**
 * Reporting: delivery funnel + booking conversion over the last N days.
 *   delivery   — count of reminder sends grouped by channel + status.
 *   conversion — distinct patients sent a follow-up reminder, and how many
 *                booked an appointment AFTER the reminder went out
 *                (createdAt >= the reminder's sentAt, not cancelled).
 */
export async function reminderStats(days = 30) {
  const pool = getPool();
  const delivery = await pool.query(
    `SELECT channel, status, count(*)::int AS n
       FROM "reminder_logs"
      WHERE "sentAt" >= now() - ($1 || ' days')::interval
      GROUP BY channel, status
      ORDER BY channel, status`,
    [String(days)],
  );
  const conversion = await pool.query(
    `WITH reminded AS (
        SELECT DISTINCT ON (rl."patientId") rl."patientId", rl."sentAt"
          FROM "reminder_logs" rl
         WHERE rl."reminderType" LIKE 'followup%'
           AND rl."patientId" IS NOT NULL
           AND rl."sentAt" >= now() - ($1 || ' days')::interval
         ORDER BY rl."patientId", rl."sentAt" DESC
      )
      SELECT
        count(*)::int AS reminded_patients,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM "appointments" a
           WHERE a."patientId" = reminded."patientId"
             AND a."createdAt" >= reminded."sentAt"
             AND a.status <> 'CANCELLED'
        ))::int AS booked_after_reminder
      FROM reminded`,
    [String(days)],
  );
  return { windowDays: days, delivery: delivery.rows, conversion: conversion.rows[0] };
}
