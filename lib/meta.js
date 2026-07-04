// Helpers for sending WhatsApp templates via Meta Cloud API.
//
// Reads the System User Token from META_WHATSAPP_TOKEN env var (mirrors the
// existing send-booking-link.js).  All sends are POST /<phone_id>/messages.

const META_PHONE_ID = '1041261462414391';   // +91 94849 57099
const META_API_BASE = 'https://graph.facebook.com/v22.0';

/** Strip everything except digits and remove a leading + so Meta's
 *  to=<digits-with-country-code> rule is satisfied. */
export function cleanPhone(raw) {
  if (!raw) return '';
  return String(raw).replace(/[^0-9]/g, '');
}

/** Normalise an Indian mobile to WhatsApp's required 91XXXXXXXXXX form.
 *  The EMR stores numbers as bare 10-digit (no country code); Meta resolves
 *  those only for numbers it already knows, so cold patient numbers can fail
 *  silently. This prepends 91 to bare 10-digit mobiles (and handles a leading
 *  trunk 0 / an already-91 number). Mirrors inbound-webhook's
 *  normalizeIndianMobile but, instead of returning null on an unrecognised
 *  shape, falls back to the cleaned digits so a send is never dropped — Meta
 *  resolves what it can. */
export function normalizeIndianWa(raw) {
  const d = cleanPhone(raw);
  if (!d) return '';
  if (d.length === 12 && d.startsWith('91') && /^[6-9]/.test(d[2])) return d;            // already 91 + 10
  if (d.length === 10 && /^[6-9]/.test(d)) return '91' + d;                              // bare 10-digit mobile
  if (d.length === 11 && d.startsWith('0') && /^[6-9]/.test(d[1])) return '91' + d.slice(1); // leading trunk 0
  if (d.length === 13 && d.startsWith('091') && /^[6-9]/.test(d[3])) return d.slice(1);  // 0 then 91 + 10
  return d; // unknown shape (international / landline) — pass cleaned digits through
}

/** Send a template message.
 *
 * @param {Object} args
 * @param {string} args.token       Meta System User token (env META_WHATSAPP_TOKEN)
 * @param {string} args.to          Recipient digits (e.g. 919866134340)
 * @param {string} args.template    Template name (e.g. followup_reminder_2d_en)
 * @param {string} args.language    Template language code (en/te/hi)
 * @param {Array}  args.parameters  Body parameters [{type:'text', text:'...'}]
 * @param {string} [args.buttonUrlParam]  Optional dynamic suffix for a URL
 *                 button at index 0 (templates whose button URL ends in {{1}}).
 * @returns {Promise<{success: boolean, wamid?: string, error?: any}>}
 */
export async function sendMetaTemplate({ token, to, template, language, parameters, buttonUrlParam }) {
  const components = parameters && parameters.length
    ? [{ type: 'body', parameters }]
    : [];
  if (buttonUrlParam) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: buttonUrlParam }],
    });
  }
  const payload = {
    messaging_product: 'whatsapp',
    to: cleanPhone(to),
    type: 'template',
    template: {
      name: template,
      language: { code: language || 'en' },
      components,
    },
  };

  try {
    const res = await fetch(`${META_API_BASE}/${META_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.messages && data.messages[0] && data.messages[0].id) {
      return { success: true, wamid: data.messages[0].id, status: data.messages[0].message_status };
    }
    return { success: false, error: data };
  } catch (e) {
    return { success: false, error: { message: e.message } };
  }
}

/** Send a free-form text message (inside the 24-hour customer-care window).
 *
 *  WhatsApp Cloud API requires a template if you're outside the window.
 *  Inside the window, free-form text is FREE — perfect for replying to
 *  inbound patient messages.
 */
export async function sendMetaText({ token, to, body }) {
  const payload = {
    messaging_product: 'whatsapp',
    to: cleanPhone(to),
    type: 'text',
    text: { body, preview_url: false },
  };
  try {
    const res = await fetch(`${META_API_BASE}/${META_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.messages && data.messages[0] && data.messages[0].id) {
      return { success: true, wamid: data.messages[0].id };
    }
    return { success: false, error: data };
  } catch (e) {
    return { success: false, error: { message: e.message } };
  }
}

export const META_PHONE_ID_EXPORT = META_PHONE_ID;
