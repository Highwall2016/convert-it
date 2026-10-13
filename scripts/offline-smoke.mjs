// Offline behaviour of the built site, in a real browser.
//
//   node scripts/offline-smoke.mjs      (needs out/ and .smoke-fixtures/)
//
// "Offline" means the server is stopped. Playwright's setOffline() does not
// apply to a service worker's own fetches in Chromium, so a test using it
// passes even when nothing is cached (that happened while writing this).
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from 'playwright';

const PORT = 3100;
const APP = `http://localhost:${PORT}`;
const FIX = join(process.cwd(), '.smoke-fixtures');
const launch = process.env.SMOKE_CHROMIUM_PATH
  ? { executablePath: process.env.SMOKE_CHROMIUM_PATH }
  : { channel: 'chrome' };

let server;
const up = async () => {
  server = spawn('node', ['scripts/serve-out.mjs', String(PORT)], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(APP);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('server did not start');
};
const down = async () => {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
};

async function convert(page, fixture, target) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="file"]:not([webkitdirectory])', { state: 'attached' });
  await page.waitForTimeout(1500); // hydration
  await page.setInputFiles('input[type="file"]:not([webkitdirectory])', join(FIX, fixture));
  const card = page.locator('[role="listitem"]').last();
  await card.locator('select[aria-label="Target format"]').selectOption(target);
  await card.locator('button[aria-label^="CONVERT →"]').click();
  const done = card.locator('button[aria-label="DOWNLOAD"]');
  const failed = card.locator('button[aria-label="RETRY"]');
  await Promise.race([done.waitFor({ timeout: 60000 }), failed.waitFor({ timeout: 60000 })]);
  if (await done.isVisible()) return 'converted';
  return (await card.locator('[role="alert"]').innerText()).split('\n')[0];
}

const results = [];
const check = (name, actual, expected) => {
  const ok = expected instanceof RegExp ? expected.test(actual) : actual === expected;
  results.push({ ok, name, actual });
};

await up();
const browser = await chromium.launch(launch);
try {
  const page = await browser.newPage({ locale: 'en-US' });
  const csp = [];
  page.on('console', (m) => /Content Security Policy/i.test(m.text()) && csp.push(m.text()));

  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'networkidle' });
  check(
    'service worker controls the page',
    String(await page.evaluate(() => !!navigator.serviceWorker.controller)),
    'true',
  );
  const netLog = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = ({ data }) => resolve(data);
          navigator.serviceWorker.controller.postMessage('network-log', [channel.port2]);
        }),
    );
  const before = await netLog();
  check('online png → webp', await convert(page, 'img.png', 'webp'), 'converted');
  // The network badge is the worker's count. The WebP codec is fetched by the
  // conversion worker, not the page, so seeing it in "received" shows worker
  // traffic is counted too; nothing is sent.
  const after = await netLog();
  const codec = await page.evaluate(async () => {
    const cached = await caches.match('/wasm/webp_enc_simd.wasm');
    return cached ? (await cached.arrayBuffer()).byteLength : 0;
  });
  const badge = page.locator('[data-testid="network-badge"]');
  await badge.waitFor({ timeout: 10000 });
  check('network badge: 0 B sent', `${after.sent} / ${await badge.innerText()}`, /^0 \/ Sent 0 B/);
  check(
    'network badge: counts the codec the worker fetched',
    String(codec > 0 && after.received - before.received >= codec),
    'true',
  );

  await down();
  check(
    'offline: reload and png → webp (used before)',
    await convert(page, 'img.png', 'webp'),
    'converted',
  );
  check(
    'offline: pdf → png never used fails with a clear error',
    await convert(page, 'doc.pdf', 'png'),
    /load the converter/i,
  );
  await page.goto(`${APP}/convert/csv-to-json`).catch(() => {});
  check('offline: unvisited converter page → home converter', new URL(page.url()).pathname, '/');

  await up();
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.locator('footer button').first().click();
  await page.waitForFunction(
    () => /✓/.test(document.querySelector('footer')?.innerText ?? ''),
    null,
    { timeout: 120000 },
  );
  check('offline pack saved', 'saved', 'saved');

  await down();
  check('offline after pack: pdf → png', await convert(page, 'doc.pdf', 'png'), 'converted');
  check(
    'offline after pack: unicode txt → pdf (CJK fonts)',
    await convert(page, 'unicode.txt', 'pdf'),
    'converted',
  );

  // Share sheet (installed app): the OS POSTs to /share-target, which only
  // the service worker answers (the server is down here, and a static host
  // has nothing there anyway); the page then collects the file on /?shared=1.
  const oversizeStatus = await page.evaluate(async () => {
    const form = new FormData();
    for (let i = 0; i < 11; i++) {
      form.append('files', new File(['x'], `extra-${i}.txt`, { type: 'text/plain' }));
    }
    const res = await fetch('/share-target', { method: 'POST', body: form });
    return res.status;
  });
  check('share target: refuses more than 10 files', oversizeStatus, 413);

  const shared = await page.evaluate(async () => {
    const form = new FormData();
    form.append('files', new File(['a,b\n1,2\n'], 'shared-data.csv', { type: 'text/csv' }));
    const res = await fetch('/share-target', { method: 'POST', body: form, redirect: 'manual' });
    return res.type;
  });
  check('share target: the worker takes the POST', shared, 'opaqueredirect');
  await page.goto(`${APP}/?shared=1`, { waitUntil: 'domcontentloaded' });
  const sharedCard = page.locator('[role="listitem"][aria-label="shared-data.csv"]');
  check(
    'share target: the shared file is queued, the inbox emptied',
    await sharedCard
      .waitFor({ timeout: 15000 })
      .then(() => page.evaluate(async () => String(await caches.has('share-inbox'))))
      .catch(() => 'not queued'),
    'false',
  );
  check('share target: ?shared is dropped from the URL', new URL(page.url()).search, '');

  check('no CSP violations', String(csp.length), '0');
} finally {
  await browser.close();
  server.kill();
}

console.log('\n=== offline ===');
for (const r of results)
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : ` (got: ${r.actual})`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
