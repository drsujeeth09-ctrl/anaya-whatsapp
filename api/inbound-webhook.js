// Vercel serverless function: Retell inbound-call webhook.
// Fires before the agent picks up.  Receives { from_number, to_number, agent_id }
// and returns dynamic_variables that the agent prompt and tool calls consume.
//
// Why this exists:
//   Retell community has confirmed two stacking bugs that break {{caller_number}} for India:
//     1. Indian carriers strip +91 from the SIP From header, so Retell's parser
//        misguesses the country (often +1) or returns blank.
//     2. The LLM hallucinates / re-formats static call variables when asked
//        to pass them to a tool.
//   This webhook normalizes from_number to clean E.164 (+91XXXXXXXXXX) BEFORE
//   the agent sees it, so neither bug can bite.
//
// Endpoint: POST /api/inbound-webhook

const ANAYA_DID = '919484957099'; // own DID — never send WhatsApp to ourselves

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'anaya-inbound-webhook',
      tip: 'POST {from_number, to_number, agent_id} — returns dynamic_variables'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = (typeof req.body === 'string') ? safeJson(req.body) : (req.body || {});
  const fromNumber = body.from_number || body.fromNumber || '';
  const toNumber = body.to_number || body.toNumber || '';

  const normalized = normalizeIndianMobile(fromNumber);
  const callerKnown = Boolean(normalized) && normalized !== ANAYA_DID;
  const last4 = callerKnown ? normalized.slice(-4) : '';

  // Household disambiguation: if multiple patients are on file for this
  // number, return their names so the V6.1 prompt can ask "is this for
  // Mom or for [Child]?". Empty string when 0 or 1 patient — V6.1 prompt
  // falls through to the normal name-prompt in that case. Best-effort:
  // a lookup failure must NEVER block the call from connecting.
  let householdMembers = '';
  if (callerKnown) {
    try {
      const tenDigit = normalized.slice(-10);
      const emrBase = process.env.EMR_BASE_URL || 'https://emr.drsujeeth.com';
      const lookupRes = await fetch(`${emrBase}/api/patients/by-phone/${tenDigit}`);
      if (lookupRes.ok) {
        const json = await lookupRes.json();
        const patients = json?.data?.patients || [];
        if (patients.length >= 2) {
          householdMembers = patients
            .map((p) => p.displayName || `${p.firstName || ''} ${p.lastName || ''}`.trim())
            .filter(Boolean)
            .join(', ');
        }
      }
    } catch (e) {
      console.warn('[inbound] household lookup failed:', e?.message);
    }
  }

  console.log(`[inbound] from=${fromNumber} to=${toNumber} normalized=${normalized || 'NONE'} known=${callerKnown} household="${householdMembers}"`);

  return res.status(200).json({
    call_inbound: {
      dynamic_variables: {
        caller_whatsapp_e164: callerKnown ? '+' + normalized : '',
        caller_whatsapp_digits: callerKnown ? normalized : '',
        caller_last4: last4,
        caller_known: callerKnown ? 'true' : 'false',
        household_members: householdMembers
      }
    }
  });
}

// Returns a 12-digit India E.164 string (no +) or null if not normalizable.
// Handles every Retell mis-parse we've seen:
//   "+919876543210"  -> "919876543210"
//   "919876543210"   -> "919876543210"
//   "9876543210"     -> "919876543210"   (raw 10-digit, India mobile)
//   "+19876543210"   -> "919876543210"   (Retell wrong-country guess)
//   "19876543210"    -> "919876543210"
//   "anonymous"/""   -> null
function normalizeIndianMobile(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  if (!digits) return null;

  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits[2])) {
    return digits;
  }
  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    return '91' + digits;
  }
  if (digits.length === 11 && digits.startsWith('1') && /^[6-9]/.test(digits[1])) {
    return '91' + digits.slice(1);
  }
  return null;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
