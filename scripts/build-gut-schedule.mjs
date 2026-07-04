// Build data/gut-challenge-schedule.json from the human-written caption sheet.
//
//   node scripts/build-gut-schedule.mjs [path-to-captions.md]
//
// Single source of truth = 42-Day-Instagram-Captions.md (Day-ordered). This
// parses each Day's blockquote caption, maps it to the actual source-clip EP
// number and a 6 AM IST date, and emits the schedule the cron reads.
//
// Mapping note: caption "Day N" -> EP file. EP28 ("Say NO to Preservatives")
// is dropped (duplicates Day 13); EP29 is the real Day-28 milestone. So from
// Day 28 on, the EP number runs one ahead of the day number.
//
// After running, fill/confirm each entry's video_url is publicly reachable
// (set IG_VIDEO_BASE_URL or edit the JSON), then commit + deploy.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CAPTIONS_PATH =
  process.argv[2] ||
  'C:\\Users\\drsuj\\Claude\\05_Social-Media\\Social Media\\Gut Health\\42-Day-Instagram-Captions.md';
const START_DATE = '2026-06-11'; // teaser day (slot 0); Day N = slot N. Shifted +2 from Jun 9 for the WhatsApp community link.
const BASE_URL =
  process.env.IG_VIDEO_BASE_URL || 'https://drsujeeth.com/wp-content/gut-challenge';
const OUT_PATH = join(__dirname, '..', 'data', 'gut-challenge-schedule.json');

const pad2 = (n) => String(n).padStart(2, '0');
function addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
// caption Day N -> source-clip EP number (EP28 dropped, so >=28 shifts up one)
const epForDay = (n) => (n === 0 ? 'EP00' : n <= 27 ? `EP${pad2(n)}` : `EP${pad2(n + 1)}`);

const lines = readFileSync(CAPTIONS_PATH, 'utf8').split(/\r?\n/);

const sections = [];
for (let i = 0; i < lines.length; i++) {
  if (/^##\s+Pre-launch teaser/i.test(lines[i])) sections.push({ day: 0, idx: i });
  const m = lines[i].match(/^###\s+Day\s+(\d+)\b/i);
  if (m) sections.push({ day: parseInt(m[1], 10), idx: i });
}

function captionFrom(startIdx) {
  const out = [];
  let started = false;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line) || /^---\s*$/.test(line)) break; // next section/divider
    if (/^>/.test(line)) {
      started = true;
      out.push(line.replace(/^>\s?/, ''));
    } else if (started) {
      break; // blockquote ended
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const seen = new Set();
const entries = [];
for (const s of sections) {
  if (seen.has(s.day)) continue; // guard against any duplicate header
  seen.add(s.day);
  const caption = captionFrom(s.idx);
  if (!caption) continue;
  const ep = epForDay(s.day);
  entries.push({
    date: addDays(START_DATE, s.day),
    time: '06:00',
    tz: 'Asia/Kolkata',
    ep,
    day: s.day === 0 ? 'Teaser' : `Day ${s.day}`,
    video_url: `${BASE_URL}/${ep}.mp4`,
    caption,
  });
}

entries.sort((a, b) => a.date.localeCompare(b.date));

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(entries, null, 2) + '\n', 'utf8');

const days = [...seen].sort((a, b) => a - b);
const missing = [];
for (let n = 0; n <= 42; n++) if (!seen.has(n)) missing.push(n === 0 ? 'Teaser' : `Day ${n}`);
const short = entries.filter((e) => e.caption.length < 30).map((e) => e.day);

console.log(`Parsed ${entries.length} entries (expected 43: teaser + Day 1..Day 42).`);
console.log(`First: ${entries[0]?.date} ${entries[0]?.ep} ${entries[0]?.day}`);
console.log(`Last:  ${entries.at(-1)?.date} ${entries.at(-1)?.ep} ${entries.at(-1)?.day}`);
if (missing.length) console.log(`WARN missing: ${missing.join(', ')}`);
if (short.length) console.log(`WARN short captions: ${short.join(', ')}`);
console.log(`Wrote ${OUT_PATH}`);
