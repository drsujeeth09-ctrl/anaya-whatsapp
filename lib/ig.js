// Instagram Reels publishing via the Graph API "Content Publishing" endpoints.
//
//   create container (POST /{ig-user-id}/media, media_type=REELS, video_url, caption)
//     -> poll status (GET /{container-id}?fields=status_code) until FINISHED
//       -> publish (POST /{ig-user-id}/media_publish, creation_id)
//
// We publish immediately on a daily cron rather than relying on IG-side
// "scheduled" publishing (publishing_type=SCHEDULED is NOT reliably supported
// for Reels). The cron fires once a day and posts that day's video.
//
// Auth: IG_PUBLISH_TOKEN — a token with instagram_basic + instagram_content_publish
//       + pages_show_list (see GUT-CHALLENGE-IG-SETUP.md). Falls back to
//       META_WHATSAPP_TOKEN only if you upgraded that token's scopes.
// Target: IG_USER_ID — the 17-digit Instagram Business Account id.

import pg from 'pg';

const GRAPH = 'https://graph.facebook.com/v22.0';

function token() {
  const t = process.env.IG_PUBLISH_TOKEN || process.env.META_WHATSAPP_TOKEN;
  if (!t) throw new Error('IG_PUBLISH_TOKEN (or META_WHATSAPP_TOKEN) not set');
  return t.trim();
}

function igUserId() {
  const id = process.env.IG_USER_ID;
  if (!id) throw new Error('IG_USER_ID not set');
  return id.trim();
}

async function graph(pathPart, { method = 'GET', params = {} } = {}) {
  const url = new URL(`${GRAPH}/${pathPart}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token()}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Graph ${method} ${pathPart} -> ${JSON.stringify(data.error || data)}`);
  }
  return data;
}

/** Step 1 — create a REELS media container (uploads the video, does not publish). */
export async function createReelContainer({ videoUrl, caption, shareToFeed = true }) {
  const data = await graph(`${igUserId()}/media`, {
    method: 'POST',
    params: { media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: shareToFeed },
  });
  return data.id; // container id
}

/** Step 2 — poll container status until FINISHED (or throw on ERROR / timeout). */
export async function waitForContainer(containerId, { maxWaitMs = 240_000, intervalMs = 5_000 } = {}) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < maxWaitMs) {
    const data = await graph(containerId, { params: { fields: 'status_code,status' } });
    last = data.status_code;
    if (last === 'FINISHED') return true;
    if (last === 'ERROR') throw new Error(`Container ${containerId} processing ERROR: ${data.status || ''}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Container ${containerId} not FINISHED within ${maxWaitMs}ms (last status: ${last})`);
}

/** Step 3 — publish a FINISHED container. Returns the published media id. */
export async function publishContainer(containerId) {
  const data = await graph(`${igUserId()}/media_publish`, {
    method: 'POST',
    params: { creation_id: containerId },
  });
  return data.id; // media id
}

/** Convenience — full create -> wait -> publish for one Reel. */
export async function publishReel({ videoUrl, caption, maxWaitMs }) {
  const containerId = await createReelContainer({ videoUrl, caption });
  await waitForContainer(containerId, maxWaitMs ? { maxWaitMs } : {});
  const mediaId = await publishContainer(containerId);
  return { containerId, mediaId };
}

/** Read-only sanity check used by the setup/test steps: who is this token? */
export async function checkAccess() {
  const me = await graph('me', { params: { fields: 'id,name' } });
  const acct = await graph(`${igUserId()}`, { params: { fields: 'id,username,followers_count' } });
  return { me, igAccount: acct };
}

// ---------------------------------------------------------------------------
// Idempotency log — one row per posted day, in the same Supabase DB the EMR
// uses. claimDate() is atomic (INSERT ... ON CONFLICT DO NOTHING), so a second
// cron run on the same day is a no-op. A failed publish releases the claim so a
// later retry can re-attempt.
// ---------------------------------------------------------------------------
let _pool = null;
function pool() {
  if (_pool) return _pool;
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL not set');
  const u = new URL(raw);
  _pool = new pg.Pool({
    host: u.hostname,
    port: parseInt(u.port || '5432', 10),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, '') || 'postgres',
    max: 2,
    idleTimeoutMillis: 30_000,
    ssl: { rejectUnauthorized: false },
  });
  return _pool;
}

export async function ensureLogTable() {
  await pool().query(`
    CREATE TABLE IF NOT EXISTS ig_publish_log (
      post_date    date PRIMARY KEY,
      ep           text,
      container_id text,
      media_id     text,
      published_at timestamptz NOT NULL DEFAULT now()
    )`);
}

/** Atomically claim a date. true = we claimed it (proceed); false = already taken (skip). */
export async function claimDate(postDate, ep) {
  await ensureLogTable();
  const r = await pool().query(
    `INSERT INTO ig_publish_log (post_date, ep) VALUES ($1, $2)
     ON CONFLICT (post_date) DO NOTHING RETURNING post_date`,
    [postDate, ep],
  );
  return r.rowCount > 0;
}

export async function recordPublished(postDate, { containerId, mediaId }) {
  await pool().query(
    `UPDATE ig_publish_log SET container_id=$2, media_id=$3, published_at=now() WHERE post_date=$1`,
    [postDate, containerId, mediaId],
  );
}

/** Roll back a claim that never published, so a retry can re-attempt that date. */
export async function releaseDate(postDate) {
  await pool().query(`DELETE FROM ig_publish_log WHERE post_date=$1 AND media_id IS NULL`, [postDate]);
}
