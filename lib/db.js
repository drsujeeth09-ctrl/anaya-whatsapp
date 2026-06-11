// Postgres client for querying the EMR's Supabase database.
//
// Reads DATABASE_URL from env (the same pgbouncer URL the EMR uses).  Uses
// `pg` library directly with parameterized queries — read-only access only.

import pg from 'pg';

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
 *                            firstName, lastName, phone, email}
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
      p.email         AS email
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
      p.email         AS email
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
      p.email         AS email
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
