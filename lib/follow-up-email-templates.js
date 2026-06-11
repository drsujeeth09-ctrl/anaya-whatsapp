// Email templates for follow-up consultation reminders + 24-hour
// appointment reminders.
//
// Used by:
//   - notifications.js  (sendFollowUpReminderEmail / sendAppointmentReminderEmail)
//   - api/follow-up-reminder/preview/route.js  (browser preview)
//   - api/follow-up-reminder/send/route.js     (one-off manual + cron-driven send)
//   - The Vercel cron in anaya-whatsapp project (when built — see
//     project_followup_reminder_workflow.md)
//
// Visual design — premium / polished look mirroring Zoho Bookings'
// transactional emails.  Clinic logo at top, structured details card,
// branded CTA, doctor signature with credentials, social handles row,
// multi-color accent band before the footer.
//
// Compatibility:
//   - Inline CSS only (Gmail/Outlook strip <style>)
//   - Tables for the outer shell (Outlook 2016+ requires this)
//   - Logo loaded from https://emr.drsujeeth.com/branding/clinic-logo.jpg
//     (already publicly served by the EMR's Next.js public/ folder).
//   - Plain-text fallback always returned alongside HTML.

// ---------------------------------------------------------------------------
// Brand + clinic constants — edit here if branding ever changes.
// ---------------------------------------------------------------------------

const BRAND = {
  primaryDark: '#0F172A',        // headline text
  primary: '#1E40AF',            // accent links
  accent: '#E86C00',             // CTA button
  accentDark: '#C45000',         // CTA hover (used for shadow tone)
  text: '#1F2937',
  textMute: '#6B7280',
  textSoft: '#94A3B8',
  bg: '#F1F5F9',                 // outer page background
  cardBg: '#FFFFFF',             // inner card background
  detailBg: '#F8FAFC',           // details panel background
  border: '#E2E8F0',
  hairline: '#CBD5E1',
  successText: '#166534',
};

const CLINIC = {
  name: "Dr. Sujeeth's Healthcare Clinic",
  tagline: 'Precision. Compassion. Recovery.',
  doctorName: 'Dr. B. Sujeeth Kumar',
  credentials: 'MBBS, MS (General Surgery), FIAGES, FAIS, FALS, DIPMAS, FICRS',
  designation: 'Senior Consultant Laparoscopic & Robotic Surgeon',
  department: 'Dept of General, Laparoscopic Surgery and Surgical Gastroenterology',
  address: 'Apollo Clinic, Manikonda, Hyderabad',
  mapUrl: 'https://maps.app.goo.gl/AhMZA5KfEaymNHay6',
  phone: '9963009090',
  website: 'drsujeeth.com',
  email: 'drsujeeth@drsujeeth.com',
  bookingUrl: 'https://drsujeethkumar.zohobookings.in/',
  // Public URL of the square clinic logo, served by the EMR's public/ folder.
  // Falls back to the production Vercel URL if NEXT_PUBLIC_APP_URL is unset.
  logoUrl: (process.env.NEXT_PUBLIC_APP_URL || 'https://emr.drsujeeth.com')
    + '/branding/clinic-logo.jpg',
};

const SOCIALS = [
  { label: 'Web',       url: 'https://drsujeeth.com',                              handle: 'drsujeeth.com' },
  { label: 'Instagram', url: 'https://instagram.com/dr.sujeeth',                   handle: '@dr.sujeeth' },
  { label: 'YouTube',   url: 'https://youtube.com/@dr.sujeeth',                    handle: '@dr.sujeeth' },
  { label: 'LinkedIn',  url: 'https://linkedin.com/in/dr-sujeeth-kumar-bashetty',  handle: 'Dr Sujeeth Kumar' },
  { label: 'Facebook',  url: 'https://facebook.com/drbsujeethkumar',               handle: 'drbsujeethkumar' },
];

// Multi-colour accent stripe — clinic-vibe palette: orange / teal / green / amber.
// Mirrors the Zoho-style colour band, but in our brand palette.
const ACCENT_COLOURS = ['#E86C00', '#0EA5E9', '#10B981', '#F59E0B'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Long-format date "Wednesday, 13 May 2026" — matches the WhatsApp template
// format so the patient sees consistent dating across channels.
function formatDateLong(date) {
  const d = (date instanceof Date) ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

// "Wed" — short weekday for compact display.
function formatWeekdayShort(date) {
  const d = (date instanceof Date) ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', { weekday: 'short' });
}

function headerHtml() {
  return `
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;background:${BRAND.cardBg};border-radius:12px 12px 0 0;border:1px solid ${BRAND.border};border-bottom:0">
      <tr>
        <td style="padding:32px 24px 18px;text-align:center">
          <img src="${CLINIC.logoUrl}" alt="${escapeHtml(CLINIC.name)}" width="84" height="84" style="display:block;margin:0 auto 14px;border-radius:14px;width:84px;height:84px;object-fit:cover;box-shadow:0 4px 14px rgba(15,23,42,0.08)" />
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:700;color:${BRAND.primaryDark};letter-spacing:0.2px;line-height:1.3">
            ${escapeHtml(CLINIC.name)}
          </div>
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;font-style:italic;color:${BRAND.textMute};margin-top:4px;letter-spacing:0.5px">
            ${escapeHtml(CLINIC.tagline)}
          </div>
          <div style="margin:14px auto 0;width:48px;height:2px;background:${BRAND.accent};border-radius:2px"></div>
        </td>
      </tr>
    </table>
  `;
}

// Compact details card — mirrors the Zoho calendar card look (subtle gray
// panel with date / time / visit-type / location rows, each prefixed by a
// tiny coloured label bar).  Used by the 24-hour appointment reminder.
// `locationHtml` is trusted pre-built HTML (anchor); escape inputs upstream.
function detailsPanelHtml({ dateLong, time, visitType, locationHtml }) {
  const row = (label, value, color) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid ${BRAND.border};vertical-align:top;width:80px">
        <span style="display:inline-block;background:${color};color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:10px;letter-spacing:0.6px;text-transform:uppercase">${label}</span>
      </td>
      <td style="padding:8px 0 8px 12px;border-bottom:1px solid ${BRAND.border};font-size:14px;color:${BRAND.text};line-height:1.4;vertical-align:top">
        ${value}
      </td>
    </tr>
  `;
  // Last row should not have bottom border — patch by adding inline override.
  return `
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;background:${BRAND.detailBg};border:1px solid ${BRAND.border};border-radius:8px;margin:16px 0;padding:14px 18px">
      <tr>
        <td>
          <table cellpadding="0" cellspacing="0" border="0" style="width:100%">
            ${row('Date', `<strong>${escapeHtml(dateLong)}</strong>`, ACCENT_COLOURS[0])}
            ${time ? row('Time', `<strong>${escapeHtml(time)}</strong>`, ACCENT_COLOURS[1]) : ''}
            ${visitType ? row('Visit', `<strong>${escapeHtml(visitType)}</strong>`, ACCENT_COLOURS[3]) : ''}
            <tr>
              <td style="padding:8px 0;vertical-align:top;width:80px">
                <span style="display:inline-block;background:${ACCENT_COLOURS[2]};color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:10px;letter-spacing:0.6px;text-transform:uppercase">Where</span>
              </td>
              <td style="padding:8px 0 8px 12px;font-size:14px;color:${BRAND.text};line-height:1.4;vertical-align:top">
                ${locationHtml}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
}

function ctaButtonHtml(url, label) {
  return `
    <table cellpadding="0" cellspacing="0" border="0" style="margin:22px auto">
      <tr>
        <td style="border-radius:8px;background:${BRAND.accent};box-shadow:0 4px 12px rgba(232,108,0,0.32)">
          <a href="${url}" style="display:inline-block;padding:15px 36px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#fff !important;text-decoration:none;letter-spacing:0.4px;border-radius:8px">
            ${escapeHtml(label)}
          </a>
        </td>
      </tr>
    </table>
  `;
}

function signatureBlockHtml() {
  return `
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-top:20px;border-top:1px solid ${BRAND.border};padding-top:16px">
      <tr>
        <td style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:${BRAND.textMute};line-height:1.55">
          <strong style="color:${BRAND.primaryDark};font-size:14px">${escapeHtml(CLINIC.doctorName)}</strong><br>
          <span style="font-size:11px">${escapeHtml(CLINIC.credentials)}</span><br>
          ${escapeHtml(CLINIC.designation)}<br>
          <em style="color:${BRAND.textSoft}">${escapeHtml(CLINIC.department)}</em><br><br>
          <strong>${escapeHtml(CLINIC.name)}</strong><br>
          ${escapeHtml(CLINIC.address)}<br>
          Phone: <a href="tel:${CLINIC.phone}" style="color:${BRAND.primary};text-decoration:none">${escapeHtml(CLINIC.phone)}</a>
          &nbsp;·&nbsp;
          Email: <a href="mailto:${CLINIC.email}" style="color:${BRAND.primary};text-decoration:none">${escapeHtml(CLINIC.email)}</a>
        </td>
      </tr>
    </table>
  `;
}

function socialRowHtml() {
  const items = SOCIALS.map((s, i) => `
    <td align="center" style="padding:6px 8px">
      <a href="${s.url}" style="font-family:Arial,Helvetica,sans-serif;color:${BRAND.primary};text-decoration:none;font-size:12px;font-weight:700">
        ${escapeHtml(s.label)}
      </a><br>
      <span style="font-family:Arial,Helvetica,sans-serif;color:${BRAND.textMute};font-size:11px">${escapeHtml(s.handle)}</span>
    </td>
  `).join('');

  return `
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-top:18px;background:${BRAND.detailBg};border-radius:8px;padding:12px 8px">
      <tr>
        <td>
          <div style="text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;color:${BRAND.textMute};letter-spacing:1.2px;text-transform:uppercase;margin-bottom:8px">
            Connect with Dr. Sujeeth
          </div>
          <table cellpadding="0" cellspacing="0" border="0" style="width:100%;text-align:center">
            <tr>${items}</tr>
          </table>
        </td>
      </tr>
    </table>
  `;
}

function accentStripeHtml() {
  // Multi-color stripe — clinic palette rather than Zoho colours.
  const segments = ACCENT_COLOURS.map(c => `<td style="background:${c};height:4px"></td>`).join('');
  return `
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-radius:0 0 12px 12px;overflow:hidden">
      <tr>${segments}</tr>
    </table>
  `;
}

// Master shell — wraps a body block with header + signature + socials +
// accent stripe + footer.
function shellHtml({ title, bodyHtml }) {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.bg};font-family:Arial,Helvetica,sans-serif;color:${BRAND.text};line-height:1.6">
    <table cellpadding="0" cellspacing="0" border="0" style="width:100%;background:${BRAND.bg};padding:28px 12px">
      <tr>
        <td align="center">
          <table cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%">
            <tr><td>${headerHtml()}</td></tr>
            <tr>
              <td style="background:${BRAND.cardBg};padding:8px 28px 24px;border-left:1px solid ${BRAND.border};border-right:1px solid ${BRAND.border}">
                ${bodyHtml}
                ${signatureBlockHtml()}
                ${socialRowHtml()}
              </td>
            </tr>
            <tr><td>${accentStripeHtml()}</td></tr>
            <tr>
              <td style="text-align:center;color:${BRAND.textSoft};font-size:11px;padding:18px 12px;line-height:1.7;font-family:Arial,Helvetica,sans-serif">
                You received this automated reminder because you're a patient of ${escapeHtml(CLINIC.name)}.<br>
                Don't want reminders like this? <a href="mailto:${CLINIC.email}?subject=STOP%20reminders" style="color:${BRAND.textMute};text-decoration:underline">Reply STOP</a> and we'll take you off the list.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// Plain-text social/signature footer — used by the text/plain fallback.
function plainFooter() {
  return [
    '--',
    CLINIC.doctorName,
    CLINIC.credentials,
    CLINIC.designation,
    `${CLINIC.name} · ${CLINIC.address}`,
    `${CLINIC.phone} · ${CLINIC.website}`,
    '',
    'Connect with us:',
    ...SOCIALS.map(s => `  ${s.label}: ${s.url}`),
    '',
    `Don't want reminders? Reply STOP.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Public render functions — return { subject, html, text }
// ---------------------------------------------------------------------------

/**
 * Follow-up reminder email.  Fires T-2 days before Consultation.followUpDate
 * (and re-fires at T-1 if the patient hasn't booked yet).
 */
export function renderFollowUpReminderEmail({ patient, followUpDate, bookingUrl }) {
  const firstName = patient?.firstName || 'there';
  const dateLong = formatDateLong(followUpDate);
  const url = bookingUrl || CLINIC.bookingUrl;

  const subject = dateLong
    ? `Your follow-up consultation is recommended on ${dateLong}`
    : `Your follow-up consultation reminder`;

  const bodyHtml = `
    <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:${BRAND.primaryDark}">
      Hi ${escapeHtml(firstName)},
    </p>
    <p style="margin:0 0 14px;font-size:14px;color:${BRAND.text}">
      This is a friendly reminder from <strong>${escapeHtml(CLINIC.name)}</strong>.
    </p>
    <p style="margin:0 0 14px;font-size:14px;color:${BRAND.text}">
      Your follow-up consultation is recommended on
      <strong style="color:${BRAND.primary}">${escapeHtml(dateLong)}</strong>.
      A timely follow-up helps Dr. Sujeeth review your recovery and adjust your treatment plan if needed.
    </p>
    ${ctaButtonHtml(url, 'Book Follow-up')}
    <p style="margin:14px 0 0;font-size:13px;color:${BRAND.textMute};text-align:center">
      Prefer to schedule by phone? Call
      <a href="tel:${CLINIC.phone}" style="color:${BRAND.primary};text-decoration:none;font-weight:700">${escapeHtml(CLINIC.phone)}</a>
    </p>
  `;

  const html = shellHtml({ title: 'Follow-up Reminder', bodyHtml });

  const text = [
    `Hi ${firstName},`,
    '',
    `This is a friendly reminder from ${CLINIC.name}.`,
    '',
    `Your follow-up consultation is recommended on ${dateLong}.`,
    `A timely follow-up helps Dr. Sujeeth review your recovery and adjust your treatment if needed.`,
    '',
    `Book a slot: ${url}`,
    `Or call: ${CLINIC.phone}`,
    '',
    plainFooter(),
  ].join('\n');

  return { subject, html, text };
}

/**
 * 24-hour appointment reminder email.  Fires the day before a booked
 * appointment.
 *
 * `appointmentType` + `meetLink` are optional (backward-compatible): a
 * TELECONSULT with a meet link renders the online variant (Join-video-call
 * anchor); everything else renders the in-clinic variant (address + Google
 * Maps anchor).
 */
export function renderAppointmentReminderEmail({ patient, appointmentDate, appointmentTime, bookingUrl, appointmentType, meetLink }) {
  const firstName = patient?.firstName || 'there';
  const dateLong = formatDateLong(appointmentDate);
  const time = appointmentTime || '';
  const url = bookingUrl || CLINIC.bookingUrl;
  const isOnline = appointmentType === 'TELECONSULT' && !!meetLink;
  const visitType = isOnline ? 'Online video consultation' : 'In-clinic consultation';
  const locationHtml = isOnline
    ? `<a href="${escapeHtml(meetLink)}" style="color:${BRAND.primary};text-decoration:none;font-weight:700">Join video call</a>`
    : `${escapeHtml(CLINIC.address)}<br><a href="${CLINIC.mapUrl}" style="color:${BRAND.primary};text-decoration:none;font-weight:700">Open in Google Maps</a>`;

  const subject = `Reminder: Your appointment with Dr. Sujeeth tomorrow${time ? ` at ${time}` : ''}`;

  const bodyHtml = `
    <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:${BRAND.primaryDark}">
      Hi ${escapeHtml(firstName)},
    </p>
    <p style="margin:0 0 12px;font-size:14px;color:${BRAND.text}">
      This is a reminder that you have an appointment with <strong>Dr. Sujeeth</strong> tomorrow.
    </p>
    ${detailsPanelHtml({ dateLong, time, visitType, locationHtml })}
    <p style="margin:14px 0;font-size:14px;color:${BRAND.text}">
      ${isOnline
        ? `Please <strong>join the video call at your appointment time</strong> using the link above.  Keep any previous reports, scans or prescription history handy.`
        : `Please <strong>arrive 10 minutes early</strong>.  Carry any previous reports, scans or prescription history if available.`}
    </p>
    ${ctaButtonHtml(url, 'Reschedule if needed')}
    <p style="margin:14px 0 0;font-size:13px;color:${BRAND.textMute};text-align:center">
      Need to talk to us? Call
      <a href="tel:${CLINIC.phone}" style="color:${BRAND.primary};text-decoration:none;font-weight:700">${escapeHtml(CLINIC.phone)}</a>
    </p>
  `;

  const html = shellHtml({ title: 'Appointment Tomorrow', bodyHtml });

  const text = [
    `Hi ${firstName},`,
    '',
    `This is a reminder that you have an appointment with Dr. Sujeeth tomorrow.`,
    '',
    `Date:     ${dateLong}`,
    time ? `Time:     ${time}` : '',
    `Visit:    ${visitType}`,
    isOnline ? `Join:     ${meetLink}` : `Where:    ${CLINIC.address}`,
    isOnline ? '' : `Map:      ${CLINIC.mapUrl}`,
    '',
    isOnline
      ? `Please join the video call at your appointment time.  Keep any previous reports handy.`
      : `Please arrive 10 minutes early.  Carry any previous reports if available.`,
    '',
    `Need to reschedule? ${url}`,
    `Or call:  ${CLINIC.phone}`,
    '',
    plainFooter(),
  ].filter(Boolean).join('\n');

  return { subject, html, text };
}

// Re-exported for the cron / preview endpoint to import without rebuilding
export { CLINIC, BRAND, SOCIALS };
