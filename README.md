# anaya-whatsapp

Vercel serverless function that bridges Retell's `send_booking_link` Custom Function call to Meta WhatsApp Business Cloud API.

Replaces n8n cloud as the middleware for Anaya's WhatsApp delivery flow.

## Architecture

```
Patient calls +919484957099
   → Voice Link DID
   → Retell (Anaya) decides to call send_booking_link
   → Retell POSTs to https://anaya-whatsapp.vercel.app/api/send-booking-link
   → This function normalises args + calls Meta Graph API
   → Meta sends template message to patient's WhatsApp
   → Function returns success/failure to Retell so Anaya can confirm or fall back
```

## Required env var

| Name | Where to set | Source |
|---|---|---|
| `META_WHATSAPP_TOKEN` | Vercel project → Settings → Environment Variables | `Vault\MASTER_CREDENTIALS.md` → "Meta WhatsApp Business Cloud API" → System User Access Token |

## Deploy (one-time)

```bash
# from this folder
npm i -g vercel
vercel login            # use dr.sujeeth09@gmail.com
vercel link             # accept defaults; create new project named anaya-whatsapp
vercel env add META_WHATSAPP_TOKEN production
# paste the token when prompted
vercel --prod
```

Production URL after first deploy: `https://anaya-whatsapp.vercel.app/api/send-booking-link` (or with team-prefix).

## Update Retell

Once deployed, update the `send_booking_link` Custom Function in Retell:
- URL: paste the production URL above
- (was: `https://sujeethkumar.app.n8n.cloud/webhook/anaya-send-booking-link`)

## Test

```bash
# Health check
curl https://anaya-whatsapp.vercel.app/api/send-booking-link

# Real send (replace phone with a number that has WhatsApp installed)
curl -X POST https://anaya-whatsapp.vercel.app/api/send-booking-link \
  -H "Content-Type: application/json" \
  -d '{
    "name": "send_booking_link",
    "args": {
      "name": "Priya Test",
      "phone": "+919866134340",
      "consultation_type": "regular",
      "language": "English"
    }
  }'
```

Expected response when templates are approved:
```json
{
  "success": true,
  "channel": "whatsapp",
  "message": "Booking link sent on WhatsApp",
  "sent_to": "919866134340",
  "template": "clinic_booking_link_en",
  "wamid": "wamid.HBgM..."
}
```

While templates are PENDING you'll get:
```json
{
  "success": false,
  "meta_error": { "error": { "code": 132012, "message": "Template name does not exist..." } }
}
```

That's expected — flip to success the moment Meta approves the template.

## Hardcoded values (review before changing the clinic)

- `META_PHONE_ID = '1041261462414391'` (the +91 94849 57099 phone)
- `ZOHO_BOOKING_URL = 'https://drsujeethkumar.zohobookings.in/'`
- Template names: `clinic_booking_link_en` / `_te` / `_hi`
- Fee mapping: regular/follow-up = 1000, emergency = 2000

If any of these change later, edit `api/send-booking-link.js` and redeploy.
