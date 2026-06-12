// Standalone test for normalizeIndianMobile — extracts the REAL function text
// from both api files (no mocks) and runs the same cases against each, so a
// drift between the two copies fails loudly.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['api/send-booking-link.js', 'api/inbound-webhook.js'];

const CASES = [
  ['09866134340', '919866134340'], // trunk-prefix dictation — the new case
  ['99866134340', null],           // 11 digits, no safe interpretation (real 2026-06-12 failure)
  ['9866134340', '919866134340'],  // raw 10-digit
  ['919866134340', '919866134340'],// already E.164 digits
  ['+91 98661 34340', '919866134340'], // formatted E.164
  ['19866134340', '919866134340'], // Retell wrong-country guess (existing case)
  ['anonymous', null],
  ['', null],
  ['09566134340', '919566134340'], // leading 0 + mobile starting 9 (range check)
  ['05566134340', null],           // leading 0 but next digit 5 → not a mobile → null
];

let failures = 0;
for (const rel of FILES) {
  const src = readFileSync(join(root, rel), 'utf8');
  const m = src.match(/function normalizeIndianMobile[\s\S]*?\n}/);
  if (!m) { console.error(`EXTRACT FAIL: ${rel}`); failures++; continue; }
  const fn = new Function(`${m[0]}; return normalizeIndianMobile;`)();
  for (const [input, expected] of CASES) {
    const got = fn(input);
    const ok = got === expected;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${rel}  ${JSON.stringify(input)} -> ${JSON.stringify(got)} (expected ${JSON.stringify(expected)})`);
  }
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
