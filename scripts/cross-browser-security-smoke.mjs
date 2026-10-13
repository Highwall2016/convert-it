// Browser privacy + cross-engine conversion checks against real Pages HTTPS.
// Focus on shared core scenarios. Browser-specific optimized codecs are
// covered separately by the full Chromium 45/45 smoke suite.
import { chromium, firefox, webkit } from 'playwright';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const app = process.env.SMOKE_URL ?? 'https://convert-it-8wh.pages.dev';
const engine = process.argv[2] ?? 'firefox';
const browsers = { chromium, firefox, webkit };
if (!browsers[engine]) throw new Error('Expected chromium, firefox or webkit');
const browser = await browsers[engine].launch(
  engine === 'chromium' ? { channel: 'chrome' } : { headless: true },
);
const origin = new URL(app).origin;
const allowed = new Set([origin, 'https://convert-assets.highwall-lab.us.ci']);
const fixtures = join(process.cwd(), '.smoke-fixtures');
const cases = [
  {
    name: 'md-html',
    file: 'doc.md',
    to: 'html',
    verify: (b) =>
      b.includes(Buffer.from('<h1>')) && b.includes(Buffer.from('Content-Security-Policy')),
  },
  {
    name: 'csv-json',
    file: 'data.csv',
    to: 'json',
    verify: (b) => JSON.parse(b.toString('utf8')).length === 2,
  },
  {
    name: 'png-webp',
    file: 'img.png',
    to: 'webp',
    verify: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  },
  {
    name: 'docx-html',
    file: 'notes.docx',
    to: 'html',
    verify: (b) => b.includes(Buffer.from('<h1>Meeting notes</h1>')),
  },
  {
    name: 'webm-mp4',
    file: 'clip.webm',
    to: 'mp4',
    verify: (b) => b.toString('latin1', 4, 8) === 'ftyp',
  },
];
const results = [];
try {
  for (const test of cases) {
    const page = await browser.newPage({ locale: 'en-US', acceptDownloads: true });
    const errors = [];
    const blocked = [];
    let coreLoaded = false;
    const requestViolations = [];
    page.context().on('request', (req) => {
      const u = new URL(req.url());
      if ((u.protocol === 'http:' || u.protocol === 'https:') && !allowed.has(u.origin))
        requestViolations.push('external-origin:' + u.origin);
      if (
        u.pathname.includes('/ffmpeg-core.wasm') &&
        u.origin === 'https://convert-assets.highwall-lab.us.ci'
      )
        coreLoaded = true;
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.exposeFunction('reportSecurityViolation', (v) => blocked.push(v));
    if (test.name === 'webm-mp4') {
      // Match the existing Chrome suite: explicitly exercise trusted FFmpeg
      // instead of letting WebKit/Firefox select native WebCodecs.
      await page.addInitScript(() => {
        delete window.VideoEncoder;
        delete window.AudioEncoder;
      });
    }
    await page.addInitScript(() =>
      document.addEventListener('securitypolicyviolation', (e) =>
        window.reportSecurityViolation(e.effectiveDirective + ':' + e.blockedURI),
      ),
    );
    try {
      const res = await page.goto(app, { waitUntil: 'networkidle', timeout: 30000 });
      if (!res?.ok()) throw new Error('HTTP ' + res?.status());
      if (!(await page.evaluate(() => crossOriginIsolated))) {
        throw new Error('not cross-origin isolated');
      }
      await page.setInputFiles(
        'input[type="file"]:not([webkitdirectory])',
        join(fixtures, test.file),
      );
      await page.locator('[role="listitem"]').first().waitFor({ timeout: 20000 });
      await page.locator('select[aria-label="Target format"]').first().selectOption(test.to);
      await page.locator('button[aria-label^="CONVERT →"]').first().click();
      const done = page.locator('button[aria-label="DOWNLOAD"]').first();
      const retry = page.locator('button[aria-label="RETRY"]').first();
      await Promise.race([
        done.waitFor({ state: 'visible', timeout: 150000 }),
        retry.waitFor({ state: 'visible', timeout: 150000 }),
      ]);
      if (await retry.isVisible())
        throw new Error('Conversion failed: ' + (errors[0] ?? 'unknown'));
      const [file] = await Promise.all([page.waitForEvent('download'), done.click()]);
      const b = readFileSync(await file.path());
      if (!test.verify(b)) throw new Error('Downloaded output failed content validation');
      if (test.name === 'webm-mp4' && !coreLoaded) throw new Error('Owner R2 WASM not requested');
      if (blocked.length) throw new Error('CSP violations: ' + blocked.join('; ').slice(0, 180));
      if (requestViolations.length)
        throw new Error('Unexpected egress: ' + requestViolations.join('; ').slice(0, 180));
      results.push({ name: test.name, ok: true, info: b.length + 'B' });
    } catch (err) {
      results.push({ name: test.name, ok: false, info: err.message.slice(0, 250) });
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
for (const r of results)
  console.log((r.ok ? 'PASS' : 'FAIL') + ' ' + engine + ' ' + r.name + ': ' + r.info);
console.log(results.filter((r) => r.ok).length + '/' + results.length + ' passed (' + engine + ')');
if (results.some((r) => !r.ok)) process.exitCode = 1;
