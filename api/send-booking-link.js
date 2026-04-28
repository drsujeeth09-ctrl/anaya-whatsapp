// Vercel serverless function: receives Retell's send_booking_link call,
// translates to Meta WhatsApp Business Cloud API, returns Anaya-friendly response.
// Endpoint: POST /api/send-booking-link
// Env var required: META_WHATSAPP_TOKEN (System User Access Token)

const META_PHONE_ID = '1041261462414391';     // +91 94849 57099 WABA phone number ID
const META_API = 'https://graph.facebook.com/v22.0';

const ZOHO_BOOKING_URL = 'https://drsujeethkumar.zohobookings.in/';

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

  // Normalise patient details
  const patientName = String(args.name || 'Patient').trim();
  const rawPhone = String(args.phone || args.caller_number || '');
  const patientPhone = rawPhone.replace(/[^0-9]/g, ''); // digits only, with country code

  if (!patientPhone || patientPhone.length < 10) {
    return res.status(200).json({
      success: false,
      message: 'Invalid phone number; please ask the secretary to follow up.',
      sent_to: patientPhone
    });
  }

  const consultationType = String(args.consultation_type || 'regular').toLowerCase().trim();
  const fee = consultationType === 'emergency' ? '2000' : '1000';

  // Map language → template name + lang code
  const lang = String(args.language || 'English').toLowerCase().trim();
  let templateName = 'clinic_booking_link_en';
  let templateLang = 'en';
  if (lang.startsWith('te')) {
    templateName = 'clinic_booking_link_te';
    templateLang = 'te';
  } else if (lang.startsWith('hi')) {
    templateName = 'clinic_booking_link_hi';
    templateLang = 'hi';
  }

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
            { type: 'text', text: patientName },
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
