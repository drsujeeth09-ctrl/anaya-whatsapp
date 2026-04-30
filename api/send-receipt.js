// Vercel serverless function: receives the EMR's "payment captured" event,
// fires the WhatsApp payment-receipt template via Meta Cloud API.
//
// Endpoint: POST /api/send-receipt
// Auth:     x-bridge-key header (shared secret with EMR)
// Env:      META_WHATSAPP_TOKEN, EMR_WABA_BRIDGE_KEY
//
// Template: payment_receipt_v1_<lang>
//   Body vars: {{1}}=name, {{2}}=amount, {{3}}=date (e.g. "29 Apr 2026")
//   URL button {{1}}=invoiceId  → emr.drsujeeth.com/api/invoices/public/<id>

import { cleanPhone } from '../lib/meta.js';

const ALLOWED_LANGS = new Set(['en', 'te', 'hi']);

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'anaya-send-receipt',
      tip: 'POST {patient_name, phone, amount, paid_on, invoice_id, language} with x-bridge-key header',
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
  const amount = String(body.amount || '').trim();
  const paidOn = String(body.paid_on || '').trim();
  const invoiceId = String(body.invoice_id || '').trim();
  const langRaw = String(body.language || 'en').toLowerCase().slice(0, 2);
  const language = ALLOWED_LANGS.has(langRaw) ? langRaw : 'en';

  if (!phoneDigits || phoneDigits.length < 10) {
    return res.status(400).json({ success: false, error: 'Invalid phone' });
  }
  if (!invoiceId || !amount || !paidOn) {
    return res.status(400).json({ success: false, error: 'invoice_id, amount and paid_on required' });
  }

  // Template families:
  //   payment_receipt_pdf_v1_<lang>  — DOCUMENT-header, attaches receipt PDF (preferred)
  //   payment_receipt_v1_<lang>      — text-header + URL button (fallback, already approved)
  const pdfTemplateName = `payment_receipt_pdf_v1_${language}`;
  const linkTemplateName = `payment_receipt_v1_${language}`;
  const receiptPublicUrl = `https://emr.drsujeeth.com/api/invoices/public/${invoiceId}`;
  const META_PHONE_ID = '1041261462414391';
  const META_API_BASE = 'https://graph.facebook.com/v22.0';

  const bodyParams = [
    { type: 'text', text: patientName },
    { type: 'text', text: amount },
    { type: 'text', text: paidOn },
  ];
  const buttonComponent = {
    type: 'button',
    sub_type: 'url',
    index: '0',
    parameters: [{ type: 'text', text: invoiceId }],
  };
  // Patient-specific receipt filename so WhatsApp doesn't fall back
  // to the URL's last path segment (random invoice ID).
  const safeName = String(patientName || 'Patient')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40) || 'Patient';
  const documentFilename = `Receipt-Dr-Sujeeth-${safeName}.pdf`;
  const documentHeader = {
    type: 'header',
    parameters: [
      {
        type: 'document',
        document: {
          link: receiptPublicUrl,
          filename: documentFilename,
        },
      },
    ],
  };

  async function trySend(name, withDocument) {
    const components = [];
    if (withDocument) components.push(documentHeader);
    components.push({ type: 'body', parameters: bodyParams });
    components.push(buttonComponent);
    const payload = {
      messaging_product: 'whatsapp',
      to: phoneDigits,
      type: 'template',
      template: { name, language: { code: language }, components },
    };
    try {
      const r = await fetch(`${META_API_BASE}/${META_PHONE_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (data?.messages?.[0]?.id) return { success: true, wamid: data.messages[0].id };
      return { success: false, error: data };
    } catch (e) {
      return { success: false, error: { message: e.message } };
    }
  }

  // 1) Try PDF-header template
  let templateUsed = pdfTemplateName;
  let result = await trySend(pdfTemplateName, true);
  // 2) If PDF failed, fall back to link-only
  if (!result.success) {
    console.warn(`[send-receipt] PDF template ${pdfTemplateName} failed, falling back to ${linkTemplateName}`);
    templateUsed = linkTemplateName;
    result = await trySend(linkTemplateName, false);
  }

  if (result.success) {
    return res.status(200).json({
      success: true,
      channel: 'whatsapp',
      template: templateUsed,
      wamid: result.wamid,
      sent_to: phoneDigits,
    });
  }
  return res.status(200).json({
    success: false,
    channel: 'whatsapp',
    template: templateUsed,
    error: result.error,
    sent_to: phoneDigits,
  });
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
