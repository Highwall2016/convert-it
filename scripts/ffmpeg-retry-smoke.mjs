// Regression: retry a temporary interruption of the pinned R2 FFmpeg WASM.
// The same fixed host and SHA-256 pins must be used on every attempt.
import { chromium, firefox, webkit } from 'playwright';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.env.SMOKE_URL ?? 'http://localhost:3000';
const origin = new URL(url).origin;
const assetOrigin = 'https://convert-assets.highwall-lab.us.ci';
const engine = process.argv[2] ?? 'chromium';
const browserEngine = { chromium, firefox, webkit }[engine];
if (!browserEngine) throw new Error('Expected chromium, firefox or webkit');
const browser = await browserEngine.launch(engine === 'chromium' ? { channel: 'chrome' } : {});
let wasmRequests = 0;
const unexpected = [];

try {
  const context = await browser.newContext({
    locale: 'en-US',
    acceptDownloads: true,
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    delete window.VideoEncoder;
    delete window.AudioEncoder;
  });
  context.on('request', (request) => {
    if (request.url().includes('ffmpeg-core')) console.log('CORE_REQUEST', request.url());
    const parsed = new URL(request.url());
    if (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.origin !== origin &&
      parsed.origin !== assetOrigin
    ) {
      unexpected.push(parsed.origin);
    }
  });
  await context.route(assetOrigin + '/ffmpeg-core/0.12.10/ffmpeg-core.wasm', async (route) => {
    wasmRequests++;
    if (wasmRequests === 1) return route.abort('failed');
    return route.continue();
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.setInputFiles(
    'input[type="file"]:not([webkitdirectory])',
    join(process.cwd(), '.smoke-fixtures', 'clip.webm'),
  );
  await page.locator('[role="listitem"]').first().waitFor();
  await page.locator('select[aria-label="Target format"]').first().selectOption('mp4');
  await page.locator('button[aria-label^="CONVERT →"]').first().click();
  const done = page.locator('button[aria-label="DOWNLOAD"]').first();
  await done.waitFor({ timeout: 120000 });
  const [download] = await Promise.all([page.waitForEvent('download'), done.click()]);
  const bytes = readFileSync(await download.path());
  if (bytes.toString('latin1', 4, 8) !== 'ftyp') throw new Error('Invalid MP4 output');
  if (wasmRequests !== 2)
    throw new Error('Expected exactly two pinned WASM requests, got ' + wasmRequests);
  if (unexpected.length) throw new Error('Unexpected origin: ' + unexpected.join(', '));
  console.log(
    'PASS FFmpeg recovery after one aborted WASM download; exact same R2 URL; valid MP4, no external origins',
  );
  await page.close();
} finally {
  await browser.close();
}
