// Helpers for detecting clinic-closure days (Sundays + India holidays).
// Used by the consultation form's follow-up date picker and (later) the
// WhatsApp reminder cron in the anaya-whatsapp Vercel project.
//
// IMPORTANT: religious / lunar-calendar holidays vary year-to-year. Edit
// the INDIA_HOLIDAYS_<YEAR> arrays at the start of each calendar year.
// Dates below are best-effort for 2026 — confirm against an official
// gazette before each new year.

const INDIA_HOLIDAYS_2026 = [
  { date: '2026-01-26', name: 'Republic Day' },
  { date: '2026-02-24', name: 'Mahashivratri' },
  { date: '2026-03-04', name: 'Holi' },
  { date: '2026-03-21', name: 'Eid al-Fitr (approx.)' },
  { date: '2026-04-03', name: 'Good Friday' },
  { date: '2026-04-14', name: 'Ambedkar Jayanti' },
  { date: '2026-05-27', name: 'Eid al-Adha (approx.)' },
  { date: '2026-08-15', name: 'Independence Day' },
  { date: '2026-09-04', name: 'Janmashtami' },
  { date: '2026-09-14', name: 'Ganesh Chaturthi' },
  { date: '2026-10-02', name: 'Gandhi Jayanti' },
  { date: '2026-10-20', name: 'Dussehra' },
  { date: '2026-11-08', name: 'Diwali' },
  { date: '2026-12-25', name: 'Christmas' },
];

const INDIA_HOLIDAYS_2027 = [
  // Stub — fill in lunar/variable dates closer to year-end 2026.
  { date: '2027-01-26', name: 'Republic Day' },
  { date: '2027-08-15', name: 'Independence Day' },
  { date: '2027-10-02', name: 'Gandhi Jayanti' },
  { date: '2027-12-25', name: 'Christmas' },
];

const ALL_HOLIDAYS = {
  2026: INDIA_HOLIDAYS_2026,
  2027: INDIA_HOLIDAYS_2027,
};

// Parse YYYY-MM-DD as a local-midnight Date (avoids the UTC-shift trap
// where `new Date('2026-05-11')` interprets the string as UTC midnight,
// which becomes the previous day in IST).
function parseLocal(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  return new Date(dateStr + 'T00:00:00');
}

function formatISO(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Today's date in YYYY-MM-DD (local time). */
export function todayISO() {
  return formatISO(new Date());
}

/** Today's date in YYYY-MM-DD as seen in IST (Asia/Kolkata).
 *  Robust to whatever timezone the host (Vercel UTC) is set to — used by
 *  the cron when scheduling reads against EMR's followUpDate. */
export function todayInIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** Add N days to a YYYY-MM-DD string. Returns YYYY-MM-DD. */
export function addDaysISO(dateStr, n) {
  const d = parseLocal(dateStr);
  if (!d) return dateStr;
  d.setDate(d.getDate() + n);
  return formatISO(d);
}

/** Days between today and dateStr (positive = future, negative = past). */
export function daysFromTodayISO(dateStr) {
  const d = parseLocal(dateStr);
  if (!d) return null;
  const today = parseLocal(todayISO());
  return Math.round((d - today) / 86400000);
}

/** True if the date string falls on a Sunday. */
export function isSunday(dateStr) {
  const d = parseLocal(dateStr);
  return !!d && d.getDay() === 0;
}

/** Returns the holiday name if dateStr is a known India holiday, else null. */
export function getHolidayName(dateStr) {
  if (!dateStr) return null;
  const year = parseInt(dateStr.slice(0, 4), 10);
  const list = ALL_HOLIDAYS[year] || [];
  const match = list.find(h => h.date === dateStr);
  return match ? match.name : null;
}

/**
 * Combined closure info.
 * @returns {{ closed: boolean, reason: string|null }}
 */
export function isClinicClosed(dateStr) {
  if (!dateStr) return { closed: false, reason: null };
  if (isSunday(dateStr)) return { closed: true, reason: 'Sunday — clinic closed' };
  const holiday = getHolidayName(dateStr);
  if (holiday) return { closed: true, reason: `${holiday} — clinic likely closed` };
  return { closed: false, reason: null };
}

/** Step backward day-by-day (up to 14 days) to the previous working day. */
export function previousWorkingDay(dateStr) {
  let d = addDaysISO(dateStr, -1);
  for (let i = 0; i < 14; i++) {
    if (!isClinicClosed(d).closed) return d;
    d = addDaysISO(d, -1);
  }
  return dateStr;
}

/** Step forward day-by-day (up to 14 days) to the next working day. */
export function nextWorkingDay(dateStr) {
  let d = addDaysISO(dateStr, 1);
  for (let i = 0; i < 14; i++) {
    if (!isClinicClosed(d).closed) return d;
    d = addDaysISO(d, 1);
  }
  return dateStr;
}

/** Format YYYY-MM-DD as "Mon, 11 May 2026". */
export function formatDateLong(dateStr) {
  const d = parseLocal(dateStr);
  if (!d) return '';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}
