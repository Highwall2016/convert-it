// Pin both single-threaded FFmpeg objects and the allowed Cloudflare Pages origin.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const base = process.argv[2];
const ORIGIN = process.env.CONVERT_IT_ORIGIN ?? 'https://convert-it-8wh.pages.dev';
const CDN = 'convert-assets.highwall-lab.us.ci';

if (!base || !base.startsWith('https://') || new URL(base).hostname !== CDN) {
  console.error('Expected https://convert-assets.highwall-lab.us.ci/ffmpeg-core/0.12.10');
  process.exit(2);
}
const source = readFileSync(join(process.cwd(), 'lib/audio-video-converters.ts'), 'utf8');
const block = source.match(/FFMPEG_CORE_SHA256 = \{([^}]*)\}/)?.[1] ?? '';
const pins = Object.fromEntries(
  [...block.matchAll(/'([^']+)':\s*'([0-9a-f]{64})'/g)].map((m) => [m[1], m[2]]),
);
if (Object.keys(pins).length !== 2) {
  console.error('Missing single-threaded FFmpeg SHA-256 pins');
  process.exit(2);
}

let ok = true;
for (const [name, expected] of Object.entries(pins)) {
  try {
    const res = await fetch(base + '/' + name, {
      headers: { Origin: ORIGIN },
      redirect: 'manual',
    });
    if (res.status !== 200 || !res.body) throw new Error('HTTP ' + res.status);
    if (res.headers.get('access-control-allow-origin') !== ORIGIN) {
      throw new Error('CORS does not allow ' + ORIGIN);
    }
    const kind = res.headers.get('content-type') ?? '';
    if (name.endsWith('.wasm') && !kind.includes('application/wasm')) {
      throw new Error('Incorrect WASM content-type: ' + kind);
    }
    const hash = createHash('sha256');
    for await (const chunk of res.body) hash.update(chunk);
    const actual = hash.digest('hex');
    if (actual !== expected) throw new Error('SHA-256 mismatch: ' + actual);
    console.log('PASS ' + name + ': ' + actual);
  } catch (err) {
    console.error('FAIL ' + name + ': ' + err.message);
    ok = false;
  }
}
process.exit(ok ? 0 : 1);
