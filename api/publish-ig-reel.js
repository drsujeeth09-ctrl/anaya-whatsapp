// Manual / test Instagram Reel publisher.
//
// Publishes ONE Reel immediately from a video_url + caption. Used to validate
// the whole pipeline (token scopes, IG_USER_ID, public video hosting) before
// trusting the daily cron (api/publish-daily-reel.js).
//
//   GET  /api/publish-ig-reel                       -> health + access check
//   POST /api/publish-ig-reel   (Bearer CRON_SECRET)
//        body: { "video_url": "...", "caption": "..." }   -> publishes now
//
// Hardened vs. the original prototype: requires CRON_SECRET (was open), uses the
// shared lib/ig.js, and drops the unreliable publishing_type=SCHEDULED path.

import { publishReel, checkAccess } from '../lib/ig.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    // Read-only access check — confirms the token + IG_USER_ID are wired up.
    try {
      const info = await checkAccess();
      return res.status(200).json({ ok: true, service: 'publish-ig-reel', ...info });
    } catch (e) {
      return res.status(200).json({ ok: false, service: 'publish-ig-reel', error: e.message,
        tip: 'Set IG_PUBLISH_TOKEN (instagram_content_publish scope) and IG_USER_ID, then retry.' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers['authorization'] || req.headers['Authorization'];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { video_url, caption } = req.body || {};
  if (!video_url || !caption) {
    return res.status(400).json({ error: 'video_url and caption are required' });
  }

  try {
    const { containerId, mediaId } = await publishReel({ videoUrl: video_url, caption });
    return res.status(200).json({ success: true, container_id: containerId, media_id: mediaId });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
