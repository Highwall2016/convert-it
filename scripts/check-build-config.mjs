// Reject releases where Cloudflare Pages, Next.js and postbuild do not agree
// on the exact owner-controlled executable-code origin.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(process.cwd(), 'out');
const url = 'https://convert-assets.highwall-lab.us.ci/ffmpeg-core/0.12.10';
const origin = new URL(url).origin;
const headers = readFileSync(join(root, '_headers'), 'utf8');
if (!headers.includes('connect-src') || !headers.includes(origin)) {
  throw new Error('Built Content-Security-Policy is missing the owned R2 origin');
}
const chunks = join(root, '_next', 'static', 'chunks');
let found = false;
function search(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      search(path);
    } else if (entry.name.endsWith('.js')) {
      const code = readFileSync(path, 'utf8');
      if (code.includes('cdn.oilygold.xyz')) {
        throw new Error('Upstream CDN reference remains in a shipped JS bundle');
      }
      if (code.includes(url)) found = true;
    }
  }
}
search(chunks);
if (!found) {
  throw new Error('Built JS bundle is missing the owner-controlled FFmpeg URL');
}
const serviceWorker = readFileSync(join(root, 'sw.js'), 'utf8');
if (!serviceWorker.includes(origin)) {
  throw new Error('Built Service Worker lacks the owner-controlled media origin');
}
console.log('[build-security] PASS: CSP, JS bundle and PWA all use the owned FFmpeg R2 CDN');
