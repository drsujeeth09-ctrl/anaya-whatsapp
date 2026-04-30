// Meta WhatsApp Cloud API webhook receiver.
//
// Handles two flows:
//   1. GET — webhook verification handshake from Meta.  Meta sends
//      ?hub.mode=subscribe&hub.verify_token=<your_token>&hub.challenge=<nonce>
//      and expects the nonce echoed as 200 plain text.
//   2. POST — actual delivery + message events.  Body is signed with
//      X-Hub-Signature-256 = HMAC-SHA256(payload, META_APP_SECRET).
//      We verify, then log the event for Vercel logs.
//
// What we look for in events:
//   - statuses[].status = sent / delivered / read / failed
//   - statuses[].id     = wamid (the message ID from our send response)
//   - statuses[].errors (if failed)
//
// For now the handler is read-only — we just log.  Future v2: persist to
// a `ReminderLog` table so we can build a delivery dashboard and auto-fall-
// back to email when a WhatsApp send fails.
//
// Configure in Meta Business Manager:
//   App > Webhooks > WhatsApp Business Account >
//     Callback URL: https://anaya-whatsapp.vercel.app/api/whatsapp-webhook
//     Verify token: $WHATSAPP_VERIFY_TOKEN (env var below)
//   Then subscribe to: messages, message_template_status_update

import crypto from 'crypto';
import { handleInboundMessage } from '../lib/wa-reply.js';

export const config = {
  api: {
    // Capture the raw body so we can verify the HMAC signature.  Vercel/
    // Next.js auto-parses JSON otherwise, which mutates the byte string.
    bodyParser: false,
  },
};

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function verifyMetaSignature(rawBody, headerSig, appSecret) {
  if (!headerSig || !appSecret) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');
  // Use constant-time comparison
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(headerSig));
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  // -- GET: verification handshake --------------------------------------
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const verifyToken = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const expected = process.env.WHATSAPP_VERIFY_TOKEN;
    if (mode === 'subscribe' && verifyToken && verifyToken === expected && challenge) {
      console.log('[whatsapp-webhook] verification OK');
      return res.status(200).send(challenge);
    }
    console.warn('[whatsapp-webhook] verification failed', { mode, hasToken: !!verifyToken });
    return res.status(403).send('Forbidden');
  }

  // -- POST: actual events ----------------------------------------------
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const raw = await readRawBody(req);
  const sig = req.headers['x-hub-signature-256'];
  const ok = verifyMetaSignature(raw, sig, process.env.META_APP_SECRET);
  if (!ok) {
    console.warn('[whatsapp-webhook] BAD SIGNATURE — rejecting');
    return res.status(403).json({ error: 'Bad signature' });
  }

  let body = {};
  try { body = JSON.parse(raw); } catch { /* ignore */ }

  // Meta wraps events in entry[].changes[].value
  const entries = body.entry || [];
  for (const entry of entries) {
    for (const change of (entry.changes || [])) {
      const v = change.value || {};
      // Status events (sent/delivered/read/failed)
      for (const s of (v.statuses || [])) {
        const log = {
          kind: 'status',
          status: s.status,
          wamid: s.id,
          recipient: s.recipient_id,
          timestamp: s.timestamp,
        };
        if (s.errors && s.errors.length) {
          log.errors = s.errors.map(e => ({ code: e.code, title: e.title, message: e.message }));
        }
        if (s.conversation) log.conversation = s.conversation;
        if (s.pricing) log.pricing = s.pricing;
        console.log('[whatsapp-webhook]', JSON.stringify(log));
      }
      // Inbound messages (patient replied with text, button, voice, etc.)
      // Pattern-match → Claude → send reply via Meta + forward to email.
      for (const m of (v.messages || [])) {
        const log = {
          kind: 'message',
          from: m.from,
          type: m.type,
          wamid: m.id,
          timestamp: m.timestamp,
        };
        if (m.button) log.button_text = m.button.text;
        if (m.text) log.text = m.text.body && m.text.body.slice(0, 200);
        console.log('[whatsapp-webhook] inbound', JSON.stringify(log));
        // Fire-and-forget so the webhook can respond 200 to Meta within
        // their 10-second budget regardless of Claude/Meta latency.  Errors
        // are still logged via wa-reply's own console.log.
        handleInboundMessage(m, v.contacts || []).catch(e => {
          console.error('[whatsapp-webhook] handleInboundMessage failed:', e?.message);
        });
      }
      // Template status updates (approval / rejection)
      if (change.field === 'message_template_status_update') {
        console.log('[whatsapp-webhook] template_status', JSON.stringify(v));
      }
    }
  }

  return res.status(200).json({ ok: true });
}
