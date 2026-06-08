// Instagram Reels Publishing Script — for Meta App Review screencast
// Path: /api/publish-ig-reel.js (Vercel serverless endpoint)
//
// USAGE (Meta App Review demo):
//   POST /api/publish-ig-reel
//   Body: {
//     "video_url": "https://drsujeeth.com/wp-content/uploads/2026/05/EP01-Day-1.mp4",
//     "caption": "Day 1 of 42 — Stop eating outside food...",
//     "scheduled_publish_time": 1747657800   // optional Unix timestamp (IST date converted to UTC)
//   }
//
// RUNS IN DEVELOPMENT MODE: works for the App owner (Dr. Sujeeth) on @drsujeeth
// before App Review approval. This is the prototype that gets recorded for the
// screencast submission.
//
// AFTER APP REVIEW APPROVAL: same script publishes to any IG Business account
// the token is authorised for.

const META_GRAPH_BASE = 'https://graph.facebook.com/v22.0';

// You'll need to fill these in BEFORE recording the screencast.
// Run this in PowerShell to discover IG_USER_ID:
//   curl -s "https://graph.facebook.com/v22.0/me/accounts?fields=instagram_business_account&access_token=$TOKEN"
const IG_USER_ID = process.env.IG_USER_ID;            // 17-digit Instagram Business Account ID
const META_TOKEN = process.env.META_WHATSAPP_TOKEN;   // Reused (will eventually need instagram_content_publish scope)

/**
 * Step 1 — Create a media container (uploads the video to IG, doesn't publish yet)
 *
 * Docs: https://developers.facebook.com/docs/instagram-api/guides/content-publishing
 */
async function createReelContainer({ video_url, caption, scheduled_publish_time }) {
  const params = new URLSearchParams({
    media_type: 'REELS',
    video_url,
    caption,
    share_to_feed: 'true',
  });

  if (scheduled_publish_time) {
    params.set('publishing_type', 'SCHEDULED');
    params.set('scheduled_publish_time', String(scheduled_publish_time));
  }

  const res = await fetch(
    `${META_GRAPH_BASE}/${IG_USER_ID}/media?${params.toString()}&access_token=${META_TOKEN}`,
    { method: 'POST' }
  );
  const data = await res.json();

  if (data.error) throw new Error(`Container creation failed: ${JSON.stringify(data.error)}`);
  return data.id;  // container ID
}

/**
 * Step 2 — Poll container status until ready
 *
 * IG processes the video upload in the background. Container goes through:
 * IN_PROGRESS → FINISHED (ready to publish) or ERROR
 */
async function waitForContainerReady(containerId, maxWaitSec = 300) {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitSec * 1000) {
    const res = await fetch(
      `${META_GRAPH_BASE}/${containerId}?fields=status_code,status&access_token=${META_TOKEN}`
    );
    const data = await res.json();

    console.log(`[Container ${containerId}] status: ${data.status_code} (${data.status || ''})`);

    if (data.status_code === 'FINISHED') return true;
    if (data.status_code === 'ERROR') throw new Error(`Container processing failed: ${data.status}`);

    // Wait 5 seconds, check again
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  throw new Error(`Container ${containerId} did not finish within ${maxWaitSec} seconds`);
}

/**
 * Step 3 — Publish the container (for immediate posting; for SCHEDULED, you skip this)
 */
async function publishContainer(containerId) {
  const res = await fetch(
    `${META_GRAPH_BASE}/${IG_USER_ID}/media_publish?creation_id=${containerId}&access_token=${META_TOKEN}`,
    { method: 'POST' }
  );
  const data = await res.json();

  if (data.error) throw new Error(`Publish failed: ${JSON.stringify(data.error)}`);
  return data.id;  // published media ID
}

/**
 * MAIN HANDLER — Vercel serverless function
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { video_url, caption, scheduled_publish_time } = req.body || {};

  if (!video_url || !caption) {
    return res.status(400).json({ error: 'video_url and caption are required' });
  }

  if (!IG_USER_ID || !META_TOKEN) {
    return res.status(500).json({ error: 'IG_USER_ID or META_WHATSAPP_TOKEN not configured' });
  }

  try {
    console.log(`[publish-ig-reel] Creating container for: ${video_url}`);
    const containerId = await createReelContainer({ video_url, caption, scheduled_publish_time });
    console.log(`[publish-ig-reel] Container created: ${containerId}`);

    console.log(`[publish-ig-reel] Waiting for processing...`);
    await waitForContainerReady(containerId);
    console.log(`[publish-ig-reel] Container ready`);

    let publishedId = null;
    if (!scheduled_publish_time) {
      // Immediate post — call media_publish
      publishedId = await publishContainer(containerId);
      console.log(`[publish-ig-reel] Published immediately. Media ID: ${publishedId}`);
    } else {
      // Scheduled — Instagram will publish automatically at scheduled_publish_time
      console.log(`[publish-ig-reel] Scheduled for ${new Date(scheduled_publish_time * 1000).toISOString()}`);
    }

    return res.status(200).json({
      success: true,
      container_id: containerId,
      published_id: publishedId,
      scheduled: !!scheduled_publish_time,
      scheduled_time_iso: scheduled_publish_time ? new Date(scheduled_publish_time * 1000).toISOString() : null,
    });

  } catch (err) {
    console.error(`[publish-ig-reel] ERROR: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
}
