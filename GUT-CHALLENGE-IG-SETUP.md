# Instagram auto-publisher — setup & activation

Automates publishing one Reel per day at **6:00 AM IST** to **@drsujeeth**, via the
Meta Graph API. Built into this `anaya-whatsapp` Vercel project (reuses its cron +
`CRON_SECRET` + Supabase DB).

## What was built
| File | Purpose |
|---|---|
| `lib/ig.js` | Graph API helpers: create container → poll → publish; idempotency log |
| `api/publish-daily-reel.js` | **The cron** — publishes today's Reel (6 AM IST). Idempotent, dry-runnable |
| `api/publish-ig-reel.js` | Manual/test endpoint — publish one Reel now; GET = access check |
| `scripts/build-gut-schedule.mjs` | Regenerates the schedule JSON from the caption sheet |
| `data/gut-challenge-schedule.json` | 43 entries (date → EP → caption → video_url). **Generated ✓** |
| `vercel.json` | Added cron `30 0 * * *` (06:00 IST) + function limits |

**Already confirmed:** @drsujeeth is connected to your Page "Dr. Sujeeth's Healthcare Clinic" (seen in Business Suite).
**Architecture note:** we publish via a daily cron (not IG-side scheduling) because `publishing_type=SCHEDULED` isn't reliable for Reels. The cron fires once, posts that day's clip, and logs it so it can't double-post.

---

## You do these 6 steps to activate

### 1. Get a token with Instagram scopes
The current `META_WHATSAPP_TOKEN` does **not** have IG scopes (verified). Get a new token with:
`instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`, `business_management`.

- Confirm the app **"Dr Sujeeth Kumar" (820170837411052)** is in **Development Mode** (App Dashboard → top toggle). In Dev Mode you can publish to **your own** @drsujeeth without waiting for App Review.
- If the app has no Instagram product yet: App Dashboard → **Add Product → Instagram → set up**.
- **Quick way (to test):** [Graph API Explorer](https://developers.facebook.com/tools/explorer) → pick the app → **Add permissions** (the five above) → **Generate Access Token** → approve. This is short-lived (~1 h).
- **Production way (for the cron):** generate a **System User** token in Business Manager → System Users → your system user → **Generate token** → select the app → tick the five scopes. System-user tokens are long-lived. Assign the @drsujeeth IG asset + the Page to that system user first (Business Settings → Accounts).
- Exchange a short-lived user token for a 60-day one if needed:
  ```
  curl -s "https://graph.facebook.com/v22.0/oauth/access_token?grant_type=fb_exchange_token&client_id=820170837411052&client_secret=APP_SECRET&fb_exchange_token=SHORT_LIVED_TOKEN"
  ```

### 2. Find your Instagram Business Account ID
**✓ CONFIRMED 2026-06-09 via `verify-ig-token.mjs`: `IG_USER_ID = 17841403928577834`** (@drsujeeth, 7,951 followers, Page "Dr. Sujeeth's Healthcare Clinic"; all 5 scopes present). The lookup below is only needed if you regenerate on a different account.
```
curl -s "https://graph.facebook.com/v22.0/me/accounts?fields=name,instagram_business_account{id,username}&access_token=YOUR_NEW_TOKEN"
```
Copy the `instagram_business_account.id` (17 digits) → that's `IG_USER_ID`.
(If `data` is empty, the token is still missing `pages_show_list`.)

### 3. Host the 43 videos at public URLs
The API fetches each video by URL (no size limit, no picker — this is why it beats the browser).
- Rename + stage clean copies:
  ```powershell
  $src="C:\Users\drsuj\Claude\05_Social-Media\Social Media\Gut Health\42-Day-Source-Clips"
  $dst="C:\Users\drsuj\Claude\05_Social-Media\Social Media\Gut Health\gut-challenge-hosted"
  New-Item -ItemType Directory -Force $dst | Out-Null
  Get-ChildItem "$src\*.mp4" | ? { $_.Name -match '^(EP\d{2})' -and $Matches[1] -ne 'EP28' } |
    % { Copy-Item $_.FullName (Join-Path $dst ($_.Name.Substring(0,4)+'.mp4')) -Force }
  ```
  (EP28 is skipped — it's the dropped duplicate.)
- Upload that folder to **`drsujeeth.com/wp-content/uploads/gut-challenge/`** via the MilesWeb file manager (FTP-style, not the WP media library, so names stay exact).
- Verify one loads: open `https://drsujeeth.com/wp-content/uploads/gut-challenge/EP00.mp4` in a browser — it should play/download.
- The JSON already points there. Using a different host? Set the base and rebuild:
  ```
  IG_VIDEO_BASE_URL="https://your-host/path" node scripts/build-gut-schedule.mjs
  ```

### 4. Set Vercel env vars
Vercel → project **anaya-whatsapp** → Settings → Environment Variables (Production):
- `IG_PUBLISH_TOKEN` = the token from step 1
- `IG_USER_ID` = the id from step 2
- (`DATABASE_URL` and `CRON_SECRET` already exist — reused.)

### 5. Deploy
```
cd Documents/Voice-Scripts/anaya-whatsapp
vercel --prod
```

### 6. Test before trusting the cron
- **Access check (read-only):** open `https://<your-deployment>/api/publish-ig-reel` (GET). Should return your IG `username` + `followers_count`. If it errors → token/scopes/IG_USER_ID problem.
- **Dry run (no posting):**
  ```
  curl -X POST "https://<deployment>/api/publish-daily-reel?dryRun=1&date=2026-06-09" -H "Authorization: Bearer YOUR_CRON_SECRET"
  ```
  Should echo the teaser it *would* post.
- **One real publish (proof):** post the teaser for real —
  ```
  curl -X POST "https://<deployment>/api/publish-ig-reel" -H "Authorization: Bearer YOUR_CRON_SECRET" \
    -H "Content-Type: application/json" \
    -d '{"video_url":"https://drsujeeth.com/wp-content/uploads/gut-challenge/EP00.mp4","caption":"test"}'
  ```
  Check @drsujeeth — the Reel should appear. (Delete it after if it was just a test.)

Once that works, **do nothing** — the cron posts each day's Reel at 6 AM IST automatically.

---

## Idempotency & ops
- A `ig_publish_log` table (auto-created in your Supabase DB) records one row per posted day; a re-run or double-fire is a no-op. A failed publish rolls back its claim so the next run retries.
- Watch runs in **Vercel → Deployments → Functions logs** (`/api/publish-daily-reel`). Each run returns a JSON summary.
- Manually post a specific day: `POST /api/publish-daily-reel?date=YYYY-MM-DD` (Bearer CRON_SECRET).

## If a publish fails — common causes
- **`(#10)` / permission error** → token lacks `instagram_content_publish`, or app needs App Review (use the draft in `Meta-App-Review-Instagram-Content-Publish.md`). In Dev Mode it should work for your own account.
- **Container `ERROR`** → the `video_url` isn't publicly reachable, or the file isn't a valid MP4 (H.264/AAC, 9:16, <90 s, <1 GB).
- **Timeout** → very large file; the staged clips are small, so unlikely. `maxDuration` is 300 s (needs the Vercel Pro plan; on Hobby it caps at 60 s — still fine for these short clips).

## ⚠ Security
While you're in Business Manager generating the new token, **rotate the old plaintext token** flagged in `Meta-App-Review-Instagram-Content-Publish.md` (it's live with ads+WhatsApp powers). Put the new IG token only in Vercel env, never in a file.
