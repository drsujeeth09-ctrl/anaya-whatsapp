// Claude (Anthropic API) wrapper for WhatsApp-Anaya chat replies.
//
// Patients message the WABA after Anaya (voice agent) sent them a booking
// link or reminder.  This module turns the inbound message into a short,
// on-brand reply, with an optional action token at the end so the webhook
// can take the right downstream action (fire booking link, route to
// secretary, mark opt-out, redirect to ER).

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5'; // fast + cheap; ~₹0.02/reply at clinic scale

const SYSTEM_PROMPT = `You are Anaya, the WhatsApp assistant for Dr. Sujeeth's Healthcare Clinic in Hyderabad. Patients message this number after Anaya (the voice agent) sent them a booking link or reminder.

You are NOT a doctor. Do not diagnose, prescribe, give medical advice, suggest dosages, or interpret reports/symptoms. You ARE a friendly admin handling booking, scheduling, opt-outs, and clinic info.

Reply rules:
- Match the language the patient wrote in (English, Telugu, or Hindi).
- Keep replies SHORT — 1 to 3 sentences, under 250 characters.
- Warm but concise. No emojis. No "kindly". No formal English. Use contractions.

End your reply with EXACTLY ONE action token if it applies (otherwise just the reply with no token):
- <<send_booking_link>> if the patient wants to book or reschedule. The system fires the booking link template right after.
- <<emergency>> if the message describes severe pain, heavy bleeding, vomiting blood, breathing difficulty, fainting, chest pain, or any other apparent medical emergency.
- <<handoff>> if the message needs human attention — medical advice, complex insurance, surgery cost specifics, complaints, anything outside basic booking/info.
- <<opt_out>> if the patient asks to stop messages, unsubscribe, or says STOP.
If unsure between options, prefer <<handoff>>.

Clinic facts:
- Doctor: Dr. B. Sujeeth Kumar — Senior Consultant Laparoscopic & Robotic Surgeon, 20+ years experience
- Location: Apollo Clinic, Manikonda, Hyderabad
- Booking URL: drsujeeth.com (or via the link Anaya already sent on WhatsApp)
- Fees: Regular ₹1,000 · Follow-up ₹1,000 · Emergency ₹2,000
- Surgery cost: depends on procedure + insurance; Dr. Sujeeth's team gives an estimate after consultation
- Insurance: cashless at Apollo Jubilee Hills with major plans
- Secretary phone: 9963009090 (clinic hours 9 AM – 8 PM, Mon–Sat)
- Emergencies go to Apollo Hospitals Emergency, Jubilee Hills (NOT the Manikonda clinic)

Hard rules:
- Never confirm slots/times yourself — always direct to the booking link.
- Never quote surgery prices.
- Never give medical advice.
- Never share Dr. Sujeeth's personal number.

Output format: just your reply text, with one of the action tokens at the very end if applicable. Nothing else — no preamble, no quotes around the reply.`;

/**
 * Generate a reply via Claude.  Returns the reply text + parsed action token.
 *
 * @param {Object} args
 * @param {string} args.message     — the patient's inbound text
 * @param {string} [args.firstName] — patient's first name if known
 * @param {string} [args.context]   — extra context (e.g. "Replying to followup_reminder_2d_en")
 * @returns {Promise<{ reply: string, action: ('send_booking_link'|'emergency'|'handoff'|'opt_out'|null), raw: string, ok: boolean, error?: any }>}
 */
export async function getClaudeReply({ message, firstName, context }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, error: { message: 'ANTHROPIC_API_KEY not set' }, reply: '', action: 'handoff', raw: '' };
  }

  const userBlock = [
    firstName ? `Patient first name: ${firstName}` : '',
    context ? `Context: ${context}` : '',
    `Patient message: ${message}`,
  ].filter(Boolean).join('\n');

  try {
    const res = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 220,
        system: [
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
        ],
        messages: [{ role: 'user', content: userBlock }],
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, error: data, reply: '', action: 'handoff', raw: '' };
    }
    const raw = (data.content || []).map(b => b.text || '').join('').trim();
    const { reply, action } = parseAction(raw);
    return { ok: true, reply, action, raw };
  } catch (e) {
    return { ok: false, error: { message: e.message }, reply: '', action: 'handoff', raw: '' };
  }
}

const KNOWN_ACTIONS = ['send_booking_link', 'emergency', 'handoff', 'opt_out'];

function parseAction(text) {
  // Match <<action>> token at end of the response, with optional trailing whitespace.
  const m = text.match(/<<\s*([a-z_]+)\s*>>\s*$/i);
  if (!m) return { reply: text, action: null };
  const action = m[1].toLowerCase();
  const reply = text.slice(0, m.index).trim();
  return {
    reply,
    action: KNOWN_ACTIONS.includes(action) ? action : null,
  };
}
