// Vercel serverless function: receives the EMR's "appointment booked" event,
// fires the WhatsApp intake-form template via Meta Cloud API.
//
// Endpoint: POST /api/send-intake-form
// Auth:     x-bridge-key header (shared secret with EMR)
// Env:      META_WHATSAPP_TOKEN, EMR_WABA_BRIDGE_KEY
//
// Template: intake_form_v1_<lang>
//   Body has no body params (transactional fixed copy).
//   URL button {{1}} = link_id slug — Meta concatenates it onto the
//   template's base URL https://emr.drsujeeth.com/intake/{{1}} so we pass
//   ONLY the linkId (not the full URL).

import { cleanPhone } from '../lib/meta.js';

const ALLOWED_LANGS = new Set(['en', 'te', 'hi']);

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'anaya-send-intake-form',
      tip: 'POST {patient_name, phone, link_id, language} with x-bridge-key header',
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
  const linkId = String(body.link_id || '').trim();
  const langRaw = String(body.language || 'en').toLowerCase().slice(0, 2);
  const language = ALLOWED_LANGS.has(langRaw) ? langRaw : 'en';

  if (!phoneDigits || phoneDigits.length < 10) {
    return res.status(400).json({ success: false, error: 'Invalid phone' });
  }
  if (!linkId || linkId.length < 4) {
    return res.status(400).json({ success: false, error: 'link_id required' });
  }
  // Defence-in-depth: linkId must be a URL-safe slug, not a full URL or
  // any path traversal. Letters, digits, hyphen, underscore only.
  if (!/^[A-Za-z0-9_-]+$/.test(linkId)) {
    return res.status(400).json({ success: false, error: 'link_id must be alphanumeric/hyphen/underscore only' });
  }

  const templateName = `intake_form_v1_${language}`;
  const META_PHONE_ID = '1041261462414391';
  const META_API_BASE = 'https://graph.facebook.com/v22.0';

  // Body has no params — transactional UTILITY template uses fixed copy.
  // The URL button parameter is the linkId slug; Meta concatenates it
  // onto the template's base URL `https://emr.drsujeeth.com/intake/{{1}}`.
  const components = [
    {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: linkId }],
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
