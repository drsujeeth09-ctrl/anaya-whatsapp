// Vercel serverless function: receives Retell's send_booking_link call,
// translates to Meta WhatsApp Business Cloud API, returns Anaya-friendly response.
// Endpoint: POST /api/send-booking-link
// Env var required: META_WHATSAPP_TOKEN (System User Access Token)

const META_PHONE_ID = '1041261462414391';     // +91 94849 57099 WABA phone number ID
const META_API = 'https://graph.facebook.com/v22.0';

const ZOHO_BOOKING_URL = 'https://drsujeethkumar.zohobookings.in/';

const ANAYA_DID = '919484957099';              // own DID — never WhatsApp ourselves

export default async function handler(req, res) {
  // CORS / health check
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'anaya-send-booking-link',
      tip: 'POST with Retell-style {args:{name,phone,consultation_type,language}}'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const TOKEN = process.env.META_WHATSAPP_TOKEN;
  if (!TOKEN) {
    console.error('META_WHATSAPP_TOKEN env var is missing');
    return res.status(500).json({
      success: false,
      message: 'Server is missing Meta token; please ask the secretary to follow up.'
    });
  }

  // Parse body — Vercel auto-parses JSON when Content-Type is application/json
  const body = (typeof req.body === 'string') ? safeJson(req.body) : (req.body || {});
  const args = body.args || body;

  // Log the full payload during the caller-ID-debug window so we can see
  // exactly what Retell sends.  Trim noisy fields.
  const dbgCall = body.call || {};
  console.log('[recv] call_id=%s from_number=%s to_number=%s args.phone=%s',
    dbgCall.call_id || 'n/a',
    dbgCall.from_number || 'n/a',
    dbgCall.to_number || 'n/a',
    args.phone || 'n/a'
  );

  // Phone resolution priority (LLM is unreliable per Retell community thread #2336):
  //   1. body.call.from_number     — Retell call metadata (authoritative caller ID)
  //   2. args.phone                — what the LLM passed (only trust if caller dictated)
  //   3. args.caller_number        — legacy fallback
  // We prefer the call metadata and only fall back to LLM-supplied args when
  // the caller dictated a number that differs from the calling number.
  const patientName = String(args.name || 'Patient').trim();
  const callFrom = String(dbgCall.from_number || '');
  const llmPhone = String(args.phone || args.caller_number || '');

  // Normalise both candidates and pick whichever resolves first.
  const callFromNorm = normalizeIndianMobile(callFrom);
  const llmPhoneNorm = normalizeIndianMobile(llmPhone);

  // Decide which to use:
  //  - If the LLM-supplied number normalises and differs from caller-ID,
  //    the caller dictated a different WhatsApp number — use the LLM's value.
  //  - Otherwise prefer the caller-ID metadata (it is the authoritative truth).
  let patientPhone = null;
  let phoneSource = 'none';
  if (llmPhoneNorm && callFromNorm && llmPhoneNorm !== callFromNorm) {
    patientPhone = llmPhoneNorm;
    phoneSource = 'llm-dictated-different';
  } else if (callFromNorm) {
    patientPhone = callFromNorm;
    phoneSource = 'call-metadata';
  } else if (llmPhoneNorm) {
    patientPhone = llmPhoneNorm;
    phoneSource = 'llm-only';
  }
  console.log('[resolve] callFromNorm=%s llmPhoneNorm=%s -> patientPhone=%s source=%s',
    callFromNorm || 'null', llmPhoneNorm || 'null', patientPhone || 'null', phoneSource);

  if (!patientPhone) {
    console.warn(`[reject] unparseable phone — call.from=${callFrom} llm=${llmPhone}`);
    return res.status(200).json({
      success: false,
      message: "I couldn't read your WhatsApp number clearly — could you say it digit by digit?",
      sent_to: llmPhone || callFrom
    });
  }

  if (patientPhone === ANAYA_DID) {
    console.warn(`[reject] phone equals own DID: ${patientPhone}`);
    return res.status(200).json({
      success: false,
      message: "That looks like our own number — could you give me your WhatsApp number digit by digit?",
      sent_to: patientPhone
    });
  }

  const consultationType = String(args.consultation_type || 'regular').toLowerCase().trim();
  const fee = consultationType === 'emergency' ? '2000' : '1000';

  // Map language → template name + lang code
  // 2026-04-29: switched from v1 → v2 template family.
  // 2026-05-04: switched Hindi from v2_hi → v3_hi.  v2_hi was auto-classified
  //   MARKETING by Meta despite being a literal translation of the UTILITY-
  //   approved English; WhatsApp's client-side filter silently dropped first-
  //   send messages.  v3_hi was reworded ("बुकिंग सूचना:" + transactional
  //   framing, no greeting) and approved as UTILITY.  See
  //   Documents/Voice-Scripts/anaya-whatsapp/templates/clinic_booking_link_v3_hi.json
  const lang = String(args.language || 'English').toLowerCase().trim();
  let templateName = 'clinic_booking_link_v2_en';
  let templateLang = 'en';
  if (lang.startsWith('te')) {
    templateName = 'clinic_booking_link_v2_te';
    templateLang = 'te';
  } else if (lang.startsWith('hi')) {
    templateName = 'clinic_booking_link_v3_hi';
    templateLang = 'hi';
  }

  // Respectful address ({{1}}): the te template body already carries the
  // honorific ("నమస్కారం {{1}} గారు") and v3_hi carries "{{1}} जी" — appending
  // "garu" there would double it. Only the English body ("Hello {{1}}, ...")
  // gets " garu", and only when Retell gave us a real name (not the
  // 'Patient' default).
  const greetingName = (templateLang === 'en' && args.name && patientName !== 'Patient')
    ? `${patientName} garu`
    : patientName;

  const metaPayload = {
    messaging_product: 'whatsapp',
    to: patientPhone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: templateLang },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: greetingName },
            { type: 'text', text: consultationType },
            { type: 'text', text: fee }
          ]
        }
      ]
    }
  };

  try {
    const metaRes = await fetch(`${META_API}/${META_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(metaPayload)
    });

    const metaData = await metaRes.json();

    if (metaData.messages && metaData.messages[0] && metaData.messages[0].id) {
      console.log(`[OK] sent ${templateName} to ${patientPhone}, wamid=${metaData.messages[0].id}`);
      return res.status(200).json({
        success: true,
        channel: 'whatsapp',
        message: 'Booking link sent on WhatsApp',
        sent_to: patientPhone,
        template: templateName,
        wamid: metaData.messages[0].id,
        booking_url: ZOHO_BOOKING_URL
      });
    } else {
      console.error('[FAIL] Meta API error:', JSON.stringify(metaData));
      return res.status(200).json({
        success: false,
        channel: 'whatsapp',
        message: 'WhatsApp send failed; please ask the secretary to follow up.',
        sent_to: patientPhone,
        meta_error: metaData
      });
    }
  } catch (err) {
    console.error('[ERR] network error:', err.message);
    return res.status(200).json({
      success: false,
      message: 'Network error reaching WhatsApp; please ask the secretary to follow up.',
      error: err.message
    });
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

// Mirror of the inbound-webhook normalizer.  Accepts every shape Retell's LLM
// might pass and returns clean 12-digit India E.164 (no +) or null.
function normalizeIndianMobile(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  if (!digits) return null;
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits[2])) return digits;
  if (digits.length === 10 && /^[6-9]/.test(digits)) return '91' + digits;
  if (digits.length === 11 && digits.startsWith('1') && /^[6-9]/.test(digits[1])) return '91' + digits.slice(1);
  return null;
}
