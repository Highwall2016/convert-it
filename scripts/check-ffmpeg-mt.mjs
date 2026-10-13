// Whether a directory or URL holds the multi-threaded FFmpeg core the app
// pins (FFMPEG_CORE_MT_SHA256 in lib/audio-video-converters.ts). A URL must
// also answer the site's origin with CORS, as the browser requires (every page
// is cross-origin isolated).
//
//   node scripts/check-ffmpeg-mt.mjs <dir | https://…/ffmpeg-core-mt/0.12.10>
//
// Exits 0 when every file matches, 1 otherwise. CI uses it to decide whether
// to build with NEXT_PUBLIC_FFMPEG_MT_BASE_URL; the upload workflow uses it
// before and after uploading.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORIGIN = process.env.CONVERT_IT_ORIGIN ?? 'https://convert-it-8wh.pages.dev';
const base = process.argv[2];
if (!base) {
  console.error('usage: check-ffmpeg-mt.mjs <dir | url>');
  process.exit(2);
}

// Read the pins from the source, so there's one copy of them.
const source = readFileSync(join(process.cwd(), 'lib/audio-video-converters.ts'), 'utf8');
const block = source.match(/FFMPEG_CORE_MT_SHA256 = \{([^}]*)\}/)?.[1];
const pins = Object.fromEntries(
  [...(block ?? '').matchAll(/'([^']+)':\s*'([0-9a-f]{64})'/g)].map((m) => [m[1], m[2]]),
);
if (Object.keys(pins).length !== 3) {
  console.error('FFMPEG_CORE_MT_SHA256 not found in lib/audio-video-converters.ts');
  process.exit(2);
}

let ok = true;
for (const [name, want] of Object.entries(pins)) {
  let bytes;
  try {
    if (/^https?:\/\//.test(base)) {
      const res = await fetch(`${base}/${name}`, { headers: { Origin: ORIGIN } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const cors = res.headers.get('access-control-allow-origin');
      if (cors !== ORIGIN && cors !== '*') throw new Error(`no CORS for ${ORIGIN}`);
      bytes = Buffer.from(await res.arrayBuffer());
    } else {
      bytes = readFileSync(join(base, name));
    }
  } catch (err) {
    console.log(`MISSING  ${name}: ${err.message}`);
    ok = false;
    continue;
  }
  const got = createHash('sha256').update(bytes).digest('hex');
  console.log(`${got === want ? 'OK      ' : 'MISMATCH'} ${name} ${got}`);
  if (got !== want) ok = false;
}
process.exit(ok ? 0 : 1);
