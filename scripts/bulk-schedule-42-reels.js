// Bulk schedule all 42 Happy Gut Challenge Reels via Instagram Graph API
// Run after Meta App Review approves instagram_content_publish scope
// PREREQUISITES:
//   1. 42 MP4 videos uploaded to drsujeeth.com/wp-content/uploads/2026/05/
//   2. IG_USER_ID env var set in Vercel
//   3. Token has instagram_content_publish + pages_show_list + business_management scopes
//
// USAGE:
//   node scripts/bulk-schedule-42-reels.js
//
// Captions are loaded from a CSV (you'll need to convert the captions doc to CSV first)
// Or paste them inline below.

const META_GRAPH_BASE = 'https://graph.facebook.com/v22.0';
const IG_USER_ID = process.env.IG_USER_ID;
const META_TOKEN = process.env.META_WHATSAPP_TOKEN;

// EDIT THIS: 42 entries with date, time, video URL, caption
// Once you upload videos to WP media library, populate video_url fields
const SCHEDULE = [
  // Pre-launch teaser
  { ep: 'EP00', date: '2026-05-18T20:00:00+05:30', video_url: 'https://drsujeeth.com/wp-content/uploads/2026/05/EP00-Heal-Your-Gut-in-42-Days.mp4', caption: '42 days. 42 short videos...' },
  { ep: 'EP01', date: '2026-05-19T20:00:00+05:30', video_url: 'https://drsujeeth.com/wp-content/uploads/2026/05/EP01-Day1-Stop-Eating-Outside.mp4', caption: 'Day 1 of 42 — Stop eating outside food...' },
  // ... 40 more entries
  { ep: 'EP42', date: '2026-06-29T20:00:00+05:30', video_url: 'https://drsujeeth.com/wp-content/uploads/2026/06/EP42-Day42-Completed.mp4', caption: 'Day 42 of 42. We did it. 🎉...' },
];

function dateToUnix(isoString) {
  return Math.floor(new Date(isoString).getTime() / 1000);
}

async function scheduleOneReel({ ep, date, video_url, caption }) {
  const scheduled_publish_time = dateToUnix(date);
  console.log(`[${ep}] Scheduling for ${date} (Unix: ${scheduled_publish_time})`);

  // Step 1: Create container
  const params = new URLSearchParams({
    media_type: 'REELS',
    video_url,
    caption,
    publishing_type: 'SCHEDULED',
    scheduled_publish_time: String(scheduled_publish_time),
    share_to_feed: 'true',
  });

  const createRes = await fetch(
    `${META_GRAPH_BASE}/${IG_USER_ID}/media?${params}&access_token=${META_TOKEN}`,
    { method: 'POST' }
  );
  const createData = await createRes.json();

  if (createData.error) {
    console.error(`[${ep}] Container creation failed:`, createData.error);
    return { ep, success: false, error: createData.error };
  }

  const containerId = createData.id;
  console.log(`[${ep}] Container created: ${containerId}`);

  // Step 2: Wait for processing (poll status)
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise(r => setTimeout(r, 5000));  // 5 sec delay

    const statusRes = await fetch(
      `${META_GRAPH_BASE}/${containerId}?fields=status_code&access_token=${META_TOKEN}`
    );
    const statusData = await statusRes.json();

    if (statusData.status_code === 'FINISHED') {
      console.log(`[${ep}] Container ready after ${(attempt + 1) * 5}s`);
      return { ep, success: true, container_id: containerId, scheduled_time: date };
    }
    if (statusData.status_code === 'ERROR') {
      console.error(`[${ep}] Processing error`);
      return { ep, success: false, error: 'Processing failed' };
    }
  }

  return { ep, success: false, error: 'Timeout waiting for processing' };
}

async function main() {
  console.log(`Scheduling ${SCHEDULE.length} Reels...`);
  const results = [];

  for (const reel of SCHEDULE) {
    const result = await scheduleOneReel(reel);
    results.push(result);

    // Rate-limit safety: IG allows 50 posts per 24h, so brief pause between calls
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('\n=== RESULTS ===');
  const success = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success);
  console.log(`Success: ${success} / ${results.length}`);
  if (failed.length) {
    console.log('Failed:');
    failed.forEach(f => console.log(`  ${f.ep}: ${JSON.stringify(f.error)}`));
  }

  // Save log to disk for audit
  const fs = await import('fs');
  const logFile = `bulk-schedule-${Date.now()}.json`;
  fs.writeFileSync(logFile, JSON.stringify(results, null, 2));
  console.log(`\nLog saved to ${logFile}`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
