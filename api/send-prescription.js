// Vercel serverless function: receives the EMR's prescription-send call,
// translates to Meta WhatsApp Business Cloud API using a UTILITY template,
// returns a Twilio-shaped response so EMR's notifications.js can swap us in
// without changing the caller contract.
//
// Endpoint: POST /api/send-prescription
// Env vars:
//   META_WHATSAPP_TOKEN      System User Access Token (already used by send-booking-link.js)
//   EMR_WABA_BRIDGE_KEY      Shared secret — EMR sends this in `x-bridge-key` header
//                            (prevents random POSTs to this public function)
//
// IMPORTANT: This requires the corresponding Meta template to be APPROVED.
// Submit `prescription_ready_v1_en` (and `_te`, `_hi`) via Meta Business
// Manager → WhatsApp Manager → Message Templates BEFORE pointing the EMR
// here. See bottom of this file for the exact template to submit.

import { cleanPhone } from '../lib/meta.js';

const ALLOWED_LANGS = new Set(['en', 'te', 'hi']);

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'anaya-send-prescription',
      tip: 'POST {patient_name, phone, public_link_id, language, pay_link?, pay_amount?} with x-bridge-key header',
    });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // --- Auth: shared secret in x-bridge-key header ---
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
  const publicLinkId = String(body.public_link_id || '').trim();
  const langRaw = String(body.language || 'en').toLowerCase().slice(0, 2);
  const language = ALLOWED_LANGS.has(langRaw) ? langRaw : 'en';
  const payLink = body.pay_link ? String(body.pay_link).trim() : '';
  const payAmount = body.pay_amount ? String(body.pay_amount).trim() : '';

  if (!phoneDigits || phoneDigits.length < 10) {
    return res.status(400).json({ success: false, error: 'Invalid phone' });
  }
  if (!publicLinkId) {
    return res.status(400).json({ success: false, error: 'public_link_id required' });
  }

  // Template families (v2 = current, v1 = legacy fallback if v2 still PENDING):
  //   prescription_pdf_v2_<lang>   — DOCUMENT-header, attaches PDF inline (preferred)
  //   prescription_ready_v2_<lang> — text + URL button (link-only fallback)
  //   prescription_pdf_v1_<lang>   — same as above, original templates
  //   prescription_ready_v1_<lang> — same as above, original templates
  //
  // Cascade: v2 PDF -> v2 link -> v1 PDF -> v1 link.
  //
  // v2 templates use "Dear {{1}}" greeting + dropped Apollo Clinic from
  // footer. v1 fallback exists so a brand-new clinic install still works
  // even if the v2 batch is mid-approval.
  //
  // English language code: v1 templates were submitted with "en", v2 with
  // "en_US" — both work, must match what Meta has on file.
  const pdfV2 = `prescription_pdf_v2_${language}`;
  const linkV2 = `prescription_ready_v2_${language}`;
  const pdfV1 = `prescription_pdf_v1_${language}`;
  const linkV1 = `prescription_ready_v1_${language}`;
  const langForV2 = language === 'en' ? 'en_US' : language;
  const langForV1 = language;
  const prescriptionPublicUrl = `https://emr.drsujeeth.com/api/prescriptions/public/${publicLinkId}`;

  // For the v2 templates we want a polished "BV Srinivas" style greeting.
  // The EMR passes patient_name as either:
  //   (a) raw "FIRSTNAME LASTNAME" (e.g. "SRINIVAS BV")  ← legacy callers
  //   (b) "Salutation FirstName" (e.g. "Mr. Faraz")     ← current EMR via
  //       formatGreetingName(), since the salutation prefix is preserved
  //
  // 2026-06-01 fix: the previous logic blindly moved the FIRST token to the
  // END, so "Mr. Faraz" became "Faraz Mr." ("Dear Faraz Mr.,") for any
  // patient who had a salutation set. Peel off a leading salutation BEFORE
  // the swap and reattach it at the front afterwards.
  const SALUTATIONS_RE = /^(mr|mrs|ms|miss|dr|baby)\.?$/i;
  const _titleCase = (s) => String(s || '').split(/\s+/).map((w) =>
    w.length <= 3 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  ).join(' ');
  const _rawTokens = String(patientName || '').trim().split(/\s+/).filter(Boolean);
  let _salPrefix = '';
  let _nameTokens = _rawTokens;
  if (_rawTokens.length > 0 && SALUTATIONS_RE.test(_rawTokens[0])) {
    // Preserve the doctor's exact salutation casing/punctuation ("Mr.", "Dr.").
    _salPrefix = _rawTokens[0];
    _nameTokens = _rawTokens.slice(1);
  }
  let _reordered;
  if (_nameTokens.length >= 2) {
    const first = _nameTokens[0];
    const rest = _nameTokens.slice(1).join(' ');
    _reordered = `${_titleCase(rest)} ${_titleCase(first)}`.trim();
  } else {
    _reordered = _titleCase(_nameTokens.join(' '));
  }
  let greetingPatientName = _salPrefix
    ? `${_salPrefix} ${_reordered}`.trim()
    : (_reordered || patientName);
  // v1 templates had different copy ("Hello {{1}}, this message is from..."), we
  // keep their fallback path with the raw patientName to avoid breaking
  // already-approved phrasing.
  const bodyParamsV2 = [{ type: 'text', text: greetingPatientName }];
  const bodyParamsV1 = [{ type: 'text', text: patientName }];

  // URL-button param (publicLinkId).
  const buttonComponent = {
    type: 'button',
    sub_type: 'url',
    index: '0',
    parameters: [{ type: 'text', text: publicLinkId }],
  };

  // Document header parameter (only for the PDF template).
  // Build a clean, patient-specific filename so WhatsApp shows
  // "Prescription-Dr-Sujeeth-SRINIVAS-BV.pdf" instead of a random
  // 32-char publicLinkId from the URL path.
  const safeName = String(patientName || 'Patient')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40) || 'Patient';
  const documentFilename = `Prescription-Dr-Sujeeth-${safeName}.pdf`;
  const documentHeader = {
    type: 'header',
    parameters: [
      {
        type: 'document',
        document: {
          link: prescriptionPublicUrl,
          filename: documentFilename,
        },
      },
    ],
  };

  // Cascade: try v2 PDF, then v2 link, then v1 PDF, then v1 link.
  // Each step records both the template name attempted AND the language code
  // it was sent with (en_US for v2-en, en for v1-en, te/hi unchanged).
  const cascade = [
    { name: pdfV2,  lang: langForV2, body: bodyParamsV2, header: documentHeader },
    { name: linkV2, lang: langForV2, body: bodyParamsV2, header: null },
    { name: pdfV1,  lang: langForV1, body: bodyParamsV1, header: documentHeader },
    { name: linkV1, lang: langForV1, body: bodyParamsV1, header: null },
  ];
  let templateUsed = null;
  let result = { success: false };
  for (const step of cascade) {
    result = await sendMetaTemplateWithButton({
      token: TOKEN,
      to: phoneDigits,
      template: step.name,
      language: step.lang,
      bodyParams: step.body,
      buttonComponent,
      headerComponent: step.header,
    });
    if (result.success) {
      templateUsed = step.name;
      break;
    }
    console.warn(`[send-prescription] ${step.name} (${step.lang}) failed, trying next in cascade`);
  }

  // Optional pay-link follow-up — same v2-first cascade.
  // Razorpay returns short URLs in three shapes: rzp.io/i/<id>, /l/<id>,
  // /rzp/<id>. All resolve to the same payment page via /i/<id>, so we
  // extract the trailing id regardless of path segment.
  let payResult = null;
  let payTemplateUsed = null;
  if (result.success && payLink && payAmount) {
    const payIdMatch = payLink.match(/rzp\.io\/(?:i|l|rzp)\/([^/?#]+)/);
    const payId = payIdMatch ? payIdMatch[1] : null;
    if (payId) {
      const payCascade = [
        { name: `prescription_pay_v2_${language}`, lang: langForV2, body: [{ type: 'text', text: greetingPatientName }, { type: 'text', text: payAmount }] },
        { name: `prescription_pay_v1_${language}`, lang: langForV1, body: [{ type: 'text', text: patientName },         { type: 'text', text: payAmount }] },
      ];
      for (const step of payCascade) {
        payResult = await sendMetaTemplateWithButton({
          token: TOKEN,
          to: phoneDigits,
          template: step.name,
          language: step.lang,
          bodyParams: step.body,
          buttonComponent: {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: payId }],
          },
        });
        if (payResult.success) {
          payTemplateUsed = step.name;
          break;
        }
        console.warn(`[send-prescription] pay template ${step.name} failed, trying next`);
      }
    }
  }

  if (result.success) {
    return res.status(200).json({
      success: true,
      channel: 'whatsapp',
      template: templateUsed,
      wamid: result.wamid,
      sent_to: phoneDigits,
      pay_template: payTemplateUsed,
      pay_wamid: payResult?.wamid || null,
      pay_error: payResult?.error || null,
    });
  }

  return res.status(200).json({
    success: false,
    channel: 'whatsapp',
    error: result.error,
    sent_to: phoneDigits,
  });
}

// sendMetaTemplate + URL-button + optional document-header extension.
async function sendMetaTemplateWithButton({ token, to, template, language, bodyParams, buttonComponent, headerComponent }) {
  const META_PHONE_ID = '1041261462414391';
  const META_API_BASE = 'https://graph.facebook.com/v22.0';
  const components = [];
  if (headerComponent) components.push(headerComponent);
  if (bodyParams && bodyParams.length) components.push({ type: 'body', parameters: bodyParams });
  if (buttonComponent) components.push(buttonComponent);
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: template,
      language: { code: language },
      components,
    },
  };
  try {
    const r = await fetch(`${META_API_BASE}/${META_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (data?.messages?.[0]?.id) return { success: true, wamid: data.messages[0].id };
    return { success: false, error: data };
  } catch (e) {
    return { success: false, error: { message: e.message } };
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

/* ============================================================================
   META TEMPLATES TO SUBMIT (Meta Business Manager → WhatsApp Manager →
   Message Templates → Create new)
   ============================================================================

   1) prescription_ready_v1_en  (UTILITY)
      Header: TEXT — "Prescription Ready"
      Body:
        Hello {{1}}, your prescription from Dr. Sujeeth Kumar is ready.
        Please tap below to view, download or share with your pharmacy.
      Footer: "Reply to this message if you have any questions."
      Buttons:
        [URL] "View Prescription"  →  https://emr.drsujeeth.com/api/prescriptions/public/{{1}}
        Sample (for review): abc123xyz

   2) prescription_ready_v1_te  (UTILITY)
      Header: TEXT — "మీ ప్రిస్క్రిప్షన్ సిద్ధం"
      Body:
        హలో {{1}}, డా. సుజిత్ కుమార్ గారి దగ్గర నుంచి మీ ప్రిస్క్రిప్షన్ సిద్ధంగా ఉంది.
        కింది బటన్ మీద క్లిక్ చేసి చూడండి, డౌన్‌లోడ్ చేయండి లేదా ఫార్మసీకి షేర్ చేయండి.
      Footer: "ఏవైనా సందేహాలు ఉంటే ఈ మెసేజ్‌కు రిప్లై ఇవ్వండి."
      Buttons:
        [URL] "ప్రిస్క్రిప్షన్ చూడండి"  →  https://emr.drsujeeth.com/api/prescriptions/public/{{1}}

   3) prescription_ready_v1_hi  (UTILITY)
      Header: TEXT — "आपकी पर्ची तैयार है"
      Body:
        नमस्ते {{1}}, डॉ. सुजीत कुमार की पर्ची तैयार है।
        देखने, डाउनलोड करने या फ़ार्मेसी से शेयर करने के लिए नीचे टैप करें।
      Footer: "किसी भी प्रश्न के लिए इस संदेश का उत्तर दें।"
      Buttons:
        [URL] "पर्ची देखें"  →  https://emr.drsujeeth.com/api/prescriptions/public/{{1}}

   4) prescription_pay_v1_en  (UTILITY)  ← optional pay-link follow-up
      Body:
        Your invoice for Rs. {{1}} is ready. Pay securely via Razorpay:
        {{2}}
        Receipt will be emailed automatically once payment is captured.
      Footer: "Powered by Razorpay · Dr. Sujeeth's Healthcare Clinic"
      (no buttons — keep payload simple; the URL is in the body so the user
       can long-press to share)

   5) prescription_pay_v1_te  (UTILITY)
      Body:
        మీ ఇన్‌వాయిస్ Rs. {{1}} సిద్ధంగా ఉంది. Razorpay ద్వారా సురక్షితంగా చెల్లించండి:
        {{2}}
        చెల్లింపు పూర్తయిన వెంటనే రసీదు ఇమెయిల్ ద్వారా పంపబడుతుంది.

   6) prescription_pay_v1_hi  (UTILITY)
      Body:
        आपका Rs. {{1}} का इनवॉइस तैयार है। Razorpay से सुरक्षित भुगतान करें:
        {{2}}
        भुगतान कैप्चर होते ही रसीद स्वतः ईमेल कर दी जाएगी।

   Approval timeline: 1–24 hours typical for UTILITY. The endpoint will
   return a 132001 / template-not-found error from Meta until approved.
   Until then, EMR's WABA send falls through to Twilio (existing behaviour).
============================================================================ */
