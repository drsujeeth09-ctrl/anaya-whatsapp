// Daily Instagram Reel publisher — fires at 07:00 IST (01:30 UTC) via Vercel cron.
//
// Looks up today's entry (IST) in data/gut-challenge-schedule.json and publishes
// that Reel to @drsujeeth. Idempotent: claims today's date in ig_publish_log
// first, so a double-fire or manual re-run won't double-post.
//
// Auth:   Authorization: Bearer ${CRON_SECRET}  (Vercel cron sends this)
// Health: GET (no auth) returns a service banner.
// Test:   POST ?dryRun=1            -> matches today, shows what WOULD publish
//         POST ?date=2026-06-09     -> run a specific day manually (still needs auth)
//
// Schedule: vercel.json -> "schedule": "30 1 * * *"  (01:30 UTC = 07:00 IST)
// See GUT-CHALLENGE-IG-SETUP.md for activation (token scopes, IG_USER_ID, hosting).

import { readFileSync } from 'node:fs';
import { publishReel, claimDate, recordPublished, releaseDate } from '../lib/ig.js';

/** YYYY-MM-DD for "today" in IST. */
function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function loadSchedule() {
  const url = new URL('../data/gut-challenge-schedule.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'ig-daily-reel',
      schedule: '30 1 * * * UTC (07:00 IST daily)',
      tip: 'POST with Authorization: Bearer $CRON_SECRET. Add ?dryRun=1 to preview, ?date=YYYY-MM-DD to run one day.',
    });
  }

  const auth = req.headers['authorization'] || req.headers['Authorization'];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun = req.query?.dryRun === '1' || req.query?.dryRun === 'true';
  const today = req.query?.date || todayIST();

  let schedule;
  try {
    schedule = loadSchedule();
  } catch (e) {
    return res.status(500).json({ error: `could not load schedule: ${e.message}` });
  }

  const entry = schedule.find((e) => e.date === today);
  const summary = { runAt: new Date().toISOString(), today, dryRun, matched: !!entry };

  if (!entry) {
    return res.status(200).json({ ...summary, note: 'no Reel scheduled for today — nothing to do' });
  }
  summary.ep = entry.ep;
  summary.day = entry.day;

  if (!entry.video_url) {
    return res.status(500).json({
      ...summary,
      error: `video_url is empty for ${entry.ep} — host the video and fill data/gut-challenge-schedule.json`,
    });
  }

  if (dryRun) {
    return res.status(200).json({
      ...summary,
      wouldPublish: {
        video_url: entry.video_url,
        caption_preview: String(entry.caption || '').slice(0, 100) + '…',
      },
    });
  }

  // Idempotency: claim today's date before doing any real work.
  let claimed;
  try {
    claimed = await claimDate(today, entry.ep);
  } catch (e) {
    return res.status(500).json({ ...summary, error: `idempotency claim failed: ${e.message}` });
  }
  if (!claimed) {
    return res.status(200).json({ ...summary, skipped: 'already published for this date' });
  }

  try {
    const { containerId, mediaId } = await publishReel({
      videoUrl: entry.video_url,
      caption: entry.caption,
    });
    await recordPublished(today, { containerId, mediaId });
    return res.status(200).json({ ...summary, published: true, container_id: containerId, media_id: mediaId });
  } catch (e) {
    await releaseDate(today).catch(() => {});
    return res.status(500).json({ ...summary, published: false, error: e.message });
  }
}
