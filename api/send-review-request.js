// Vercel serverless function: receives the EMR's "ask for Google review"
// event, fires a MARKETING WABA template via Meta Cloud API.
//
// Endpoint: POST /api/send-review-request
// Auth:     x-bridge-key header (shared secret with EMR)
// Env:      META_WHATSAPP_TOKEN, EMR_WABA_BRIDGE_KEY
//
// Template: clinic_review_request_v1_<lang>
//   Body var: {{1}} = greeting name (e.g. "Mr. Faraz" / "Sunitha garu")
//   URL button {{1}} = full review URL — Meta requires the URL be passed
//                      as the button parameter even though the template
//                      itself stores the base. Pass the value verbatim.

import { cleanPhone } from '../lib/meta.js';

const ALLOWED_LANGS = new Set(['en', 'te', 'hi']);

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'anaya-send-review-request',
      tip: 'POST {patient_name, phone, review_url, language} with x-bridge-key header',
    });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const expectedKey = process.env.EMR_WABA_BRIDGE_KEY;
  if (expectedKey) {
    const got = req.headers['x-bridge-key'] || req.headers['X-Bridge-Key'];
    if (got !== expectedKey) {
      return res.status(401).json({ success: false, error: 'unauthorized' });
    }
  }

  const TOKEN = process.env.META_WHATSAPP_TOKEN;
  if (!TOKEN) {
    return res.status(500).json({ success: false, error: 'META_WHATSAPP_TOKEN not set' });
  }

  const body = (typeof req.body === 'string') ? safeJson(req.body) : (req.body || {});

  const patientName = String(body.patient_name || 'Patient').trim();
  const phoneDigits = cleanPhone(body.phone);
  const reviewUrl = String(body.review_url || '').trim();
  const langRaw = String(body.language || 'en').toLowerCase().slice(0, 2);
  const language = ALLOWED_LANGS.has(langRaw) ? langRaw : 'en';

  if (!phoneDigits || phoneDigits.length < 10) {
    return res.status(400).json({ success: false, error: 'Invalid phone' });
  }
  if (!reviewUrl || !/^https?:\/\//.test(reviewUrl)) {
    return res.status(400).json({ success: false, error: 'review_url required (http/https)' });
  }

  const templateName = `clinic_review_request_v1_${language}`;
  const META_PHONE_ID = '1041261462414391';
  const META_API_BASE = 'https://graph.facebook.com/v22.0';

  // The button URL is suffixed onto the template's base URL by Meta — we
  // pass the FULL final URL as the parameter and let Meta handle it. Most
  // installations approve the template with a `*` wildcard suffix so any
  // review_url passes through unmodified.
  const components = [
    { type: 'body', parameters: [{ type: 'text', text: patientName }] },
    {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: reviewUrl }],
    },
  ];

  const payload = {
    messaging_product: 'whatsapp',
    to: phoneDigits,
    type: 'template',
    template: { name: templateName, language: { code: language }, components },
  };

  try {
    const r = await fetch(`${META_API_BASE}/${META_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (data?.messages?.[0]?.id) {
      return res.status(200).json({
        success: true,
        channel: 'whatsapp',
        template: templateName,
        wamid: data.messages[0].id,
        sent_to: phoneDigits,
      });
    }
    return res.status(200).json({
      success: false,
      channel: 'whatsapp',
      template: templateName,
      error: data,
      sent_to: phoneDigits,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: { message: e.message } });
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
