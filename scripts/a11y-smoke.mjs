// Accessibility of the built site, in a real browser: axe-core (WCAG 2.1 A and
// AA rules) on every page and on the states that only exist after
// interaction: job cards with their settings open, a preview, an error card,
// the Undo toast, both themes. Serious and critical violations fail it.
//
//   npm run fixtures && npm run serve   (then, in another shell)
//   node scripts/a11y-smoke.mjs
//
// axe runs through page.evaluate, which the page's CSP doesn't apply to, so
// the site is tested with its real headers.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { chromium } from 'playwright';

const APP = process.env.SMOKE_URL ?? 'http://localhost:3000';
const FIX = join(process.cwd(), '.smoke-fixtures');
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const launch = process.env.SMOKE_CHROMIUM_PATH
  ? { executablePath: process.env.SMOKE_CHROMIUM_PATH }
  : { channel: 'chrome' };

const results = [];

async function audit(page, name) {
  await page.evaluate(AXE);
  const { violations } = await page.evaluate(() =>
    axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      resultTypes: ['violations'],
    }),
  );
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  results.push({ name, blocking, minor: violations.length - blocking.length });
}

const settle = (page) => page.waitForTimeout(700); // framer-motion enter animations

const browser = await chromium.launch(launch);
try {
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({ colorScheme: theme, locale: 'en-US' });
    const page = await context.newPage();
    await page.goto(APP, { waitUntil: 'networkidle' });
    await settle(page);
    await audit(page, `home, empty (${theme})`);

    await page.setInputFiles('input[type="file"]:not([webkitdirectory])', [
      join(FIX, 'img.png'),
      join(FIX, 'clip.webm'),
      join(FIX, 'doc.pdf'),
      join(FIX, 'data.csv'),
    ]);
    // A file nothing reads, for the error card.
    await page.setInputFiles('input[type="file"]:not([webkitdirectory])', {
      name: 'layers.psd',
      mimeType: 'image/vnd.adobe.photoshop',
      buffer: Buffer.from('8BPSrest'),
    });
    await settle(page);
    const cards = page.locator('[role="listitem"]');
    for (let i = 0; i < 4; i++) {
      const gear = cards
        .nth(i)
        .locator('button[aria-label*="ettings"], button[aria-label*="SETTINGS"]');
      if (await gear.count()) await gear.first().click();
    }
    await settle(page);
    await audit(page, `home, cards with settings open (${theme})`);

    const image = cards.first();
    await image.locator('button[aria-label^="CONVERT →"]').click();
    await image.locator('button[aria-label="DOWNLOAD"]').waitFor({ timeout: 60000 });
    await image.getByRole('button', { name: 'VIEW' }).click();
    await settle(page);
    await audit(page, `home, result preview (${theme})`);

    // The conversion above was counted: open the local stats table.
    await page.locator('details summary', { hasText: /stats/i }).click();
    await settle(page);
    await audit(page, `home, stats panel (${theme})`);

    await page
      .getByRole('region', { name: 'files' })
      .getByRole('button', { name: 'CLEAR' })
      .click();
    // The empty page's cards fade in on a stagger: audit them at rest.
    await page.waitForTimeout(2000);
    await audit(page, `home, Undo toast (${theme})`);

    for (const path of ['/about', '/convert/png-to-jpg']) {
      await page.goto(`${APP}${path}`, { waitUntil: 'networkidle' });
      await settle(page);
      await audit(page, `${path} (${theme})`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}

console.log('\n=== accessibility (axe, WCAG 2.1 AA) ===');
let failed = 0;
for (const { name, blocking, minor } of results) {
  console.log(`${blocking.length ? 'FAIL' : 'PASS'}  ${name}${minor ? ` (${minor} minor)` : ''}`);
  for (const v of blocking) {
    console.log(`      ${v.impact} ${v.id}: ${v.help}`);
    for (const node of v.nodes.slice(0, 4)) {
      console.log(
        `        ${node.target.join(' ')}  ${node.failureSummary?.split('\n')[1]?.trim() ?? ''}`,
      );
    }
    if (v.nodes.length > 4) console.log(`        …and ${v.nodes.length - 4} more`);
  }
  if (blocking.length) failed++;
}
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
