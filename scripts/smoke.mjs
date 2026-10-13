// One conversion pair per engine, driven through the real UI in a real browser.
// Verifies the downloaded bytes, not just that the button turned green — a converter
// that emits an empty or wrong-typed blob still reaches the "done" state.
//
//   node scripts/smoke.mjs            # Chrome
//   node scripts/smoke.mjs webkit     # Safari engine
//   SMOKE_EXPECT_MT=1 node scripts/smoke.mjs   # build has the multi-threaded core
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { createCanvas, loadImage } from 'canvas';

const APP = process.env.SMOKE_URL ?? 'http://localhost:3000';
const DIR = join(process.cwd(), '.smoke-fixtures');
const engine = process.argv[2] === 'webkit' ? 'webkit' : 'chrome';
// Set when the build has NEXT_PUBLIC_FFMPEG_MT_BASE_URL: media pairs must then
// run on the multi-threaded core, not quietly fall back.
const EXPECT_MT = process.env.SMOKE_EXPECT_MT === '1';

// [fixture, target format, engine under test, validator]
const isText = (b) => b.length > 0 && !b.subarray(0, 512).includes(0);
const magic =
  (sig, off = 0) =>
  (b) =>
    b.subarray(off, off + sig.length).toString('latin1') === sig;

const PAIRS = [
  ['img.png', 'webp', 'libwebp', (b) => magic('RIFF')(b) && magic('WEBP', 8)(b)],
  ['img.png', 'jpg', 'mozjpeg', (b) => b[0] === 0xff && b[1] === 0xd8],
  ['img.svg', 'png', 'resvg + oxipng', magic('\x89PNG')],
  ['img.png', 'avif', 'libavif', magic('ftypavif', 4)],
  // Privacy default: a geotagged photo comes out with no EXIF at all.
  [
    'geo.jpg',
    'jpg',
    'metadata stripped',
    (b) => b[0] === 0xff && b[1] === 0xd8 && !b.includes('Exif') && !b.includes('Smoke Test'),
  ],
  ['img.png', 'jxl', 'libjxl encode', (b) => b[0] === 0xff && b[1] === 0x0a],
  ['img.jxl', 'png', 'libjxl decode', magic('\x89PNG')],
  [
    'cmyk-packbits.tiff',
    'png',
    'utif cmyk (worker)',
    async (b) => {
      // Quadrants red, green / blue, white: check the top-left is red.
      const img = await loadImage(b);
      const ctx = createCanvas(img.width, img.height).getContext('2d');
      ctx.drawImage(img, 0, 0);
      const [r, g, bl] = ctx.getImageData(2, 2, 1, 1).data;
      return r > 250 && g < 5 && bl < 5;
    },
  ],
  ['bilevel-g4.tiff', 'pdf', 'utif g4 → pdf', magic('%PDF')],
  ['doc.pdf', 'png', 'pdfium', magic('\x89PNG')],
  [
    'blue.pdf',
    'png',
    'pdfium colours',
    async (b) => {
      // Decode the PNG and check the centre really is blue, not red.
      const img = await loadImage(b);
      const canvas = createCanvas(img.width, img.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const [r, g, bl] = ctx.getImageData(img.width >> 1, img.height >> 1, 1, 1).data;
      return r < 20 && g < 20 && bl > 235;
    },
  ],
  [
    'unicode.txt',
    'pdf',
    'noto fonts (worker)',
    (b) => magic('%PDF')(b) && /NotoSansSC-Regular/.test(b.toString('latin1')),
  ],
  ['clip.mkv', 'webm', 'ffmpeg vp8+vorbis', (b) => b.readUInt32BE(0) === 0x1a45dfa3],
  // Same fixtures through the browser's codecs. VP8/Opus in, VP9/Opus and PCM
  // out, which every Chromium has (Playwright's own lacks H.264 and AAC).
  ['clip.mkv', 'webm', 'webcodecs vp9+opus', (b) => b.readUInt32BE(0) === 0x1a45dfa3],
  ['clip.webm', 'wav', 'webcodecs extract', (b) => magic('RIFF')(b) && magic('WAVE', 8)(b)],
  ['clip.webm', 'mp4', 'ffmpeg video', magic('ftyp', 4)],
  ['clip.webm', 'gif', 'ffmpeg gif', magic('GIF89a')],
  [
    'audio.wav',
    'mp3',
    'ffmpeg audio',
    (b) => magic('ID3')(b) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  ],
  [
    'clip.webm',
    'mp3',
    'ffmpeg extract',
    (b) => magic('ID3')(b) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  ],
  // Inputs only FFmpeg reads (committed fixtures, one per demuxer family).
  ['sample.mpg', 'mp4', 'ffmpeg mpeg-ps', magic('ftyp', 4)],
  [
    'sample.vob',
    'mp3',
    'ffmpeg vob ac3',
    (b) => magic('ID3')(b) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  ],
  ['sample.m2ts', 'mp4', 'ffmpeg m2ts', magic('ftyp', 4)],
  ['sample.wmv', 'webm', 'ffmpeg wmv', (b) => b.readUInt32BE(0) === 0x1a45dfa3],
  [
    'sample.aiff',
    'mp3',
    'ffmpeg aiff',
    (b) => magic('ID3')(b) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  ],
  ['sample.amr', 'wav', 'ffmpeg amr', (b) => magic('RIFF')(b) && magic('WAVE', 8)(b)],
  ['sample.dts', 'flac', 'ffmpeg dts', magic('fLaC')],
  ['data.csv', 'json', 'data', (b) => JSON.parse(b.toString()).length === 2],
  ['data.csv', 'xlsx', 'xlsx writer', magic('PK')],
  ['data.json', 'yaml', 'yaml', (b) => b.toString().includes('name:')],
  ['doc.md', 'html', 'document', (b) => /<(h1|strong|a)\b/i.test(b.toString())],
  ['doc.pdf', 'pdf', 'pdf-lib edit', magic('%PDF')],
  [
    'sub.srt',
    'vtt',
    'subtitles',
    (b) => /^WEBVTT\n\n00:00:01\.000 --> 00:00:03\.500\nHello <i>there<\/i>/.test(b.toString()),
  ],
  ['ocr.png', 'txt', 'tesseract OCR', (b) => /reads printed text/.test(b.toString())],
  ['scan.pdf', 'txt', 'scanned PDF → OCR', (b) => /Invoice 2026 total 314/.test(b.toString())],
  ['doc.md', 'docx', 'docx writer', (b) => magic('PK')(b) && b.includes('word/document.xml')],
  [
    'notes.docx',
    'html',
    'mammoth (worker)',
    (b) => b.toString().includes('<h1>Meeting notes</h1>'),
  ],
  ['notes.docx', 'pdf', 'docx → pdf (main)', magic('%PDF')],
  ['img.png', 'pdf', 'pdf-lib image', magic('%PDF')],
  ['doc.txt', 'pdf', 'jspdf (worker)', magic('%PDF')],
  ['data.json', 'pdf', 'jspdf json (worker)', magic('%PDF')],
  ['doc.md', 'pdf', 'jspdf md (main)', magic('%PDF')],
  [
    'doc.md',
    'epub',
    'epub (main)',
    (b) => magic('PK')(b) && magic('mimetypeapplication/epub+zip', 30)(b),
  ],
  ['data.xml', 'csv', 'xml (worker)', (b) => b.toString() === '@id,title\r\n1,Dune\r\n2,Ubik'],
];

// Google Chrome by default (what CI runners have); SMOKE_CHROMIUM_PATH points
// at any other Chromium build, e.g. Playwright's own when Chrome isn't installed.
const chromeLaunch = process.env.SMOKE_CHROMIUM_PATH
  ? { executablePath: process.env.SMOKE_CHROMIUM_PATH }
  : { channel: 'chrome' };
const browser = await (engine === 'webkit' ? webkit.launch() : chromium.launch(chromeLaunch));

const results = [];

// Media pairs pin their engine. ffmpeg pairs hide WebCodecs, so they keep
// testing the wasm core even in browsers where the fast path would take them;
// both kinds check whether the core was actually fetched.
const engineOf = (label) =>
  label.startsWith('ffmpeg') ? 'ffmpeg' : label.startsWith('webcodecs') ? 'webcodecs' : null;

for (const [fixture, target, label, check] of PAIRS) {
  const page = await browser.newPage({ locale: 'en-US' });
  const consoleErrors = [];
  const networkErrors = [];
  // Record failed core or lazy JS loads, not just the user-friendly error title.
  // These details help distinguish a transient CDN issue from an engine crash.
  page.context().on('requestfailed', (req) => {
    if (req.url().includes('ffmpeg-core') || req.url().includes('/_next/static/')) {
      networkErrors.push(req.url() + ': ' + (req.failure()?.errorText ?? 'request failed'));
    }
  });
  page.context().on('response', (res) => {
    if (
      res.status() >= 400 &&
      (res.url().includes('ffmpeg-core') || res.url().includes('/_next/static/'))
    ) {
      networkErrors.push('HTTP ' + res.status() + ' ' + res.url());
    }
  });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  // The loader warns when it gives up on the multi-threaded FFmpeg core.
  const mtFallbacks = [];
  page.on('console', (m) => /Multi-threaded FFmpeg/.test(m.text()) && mtFallbacks.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  // Any CSP violation fails the pair, even if the conversion still succeeded:
  // it means the policy and the app have drifted apart.
  const cspViolations = [];
  await page.exposeFunction('__reportCsp', (v) => cspViolations.push(v));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) =>
      window.__reportCsp(`${e.effectiveDirective} blocked ${e.blockedURI || 'inline'}`),
    );
  });
  const watchCsp = (m) => {
    if (/Content Security Policy/i.test(m.text())) cspViolations.push(m.text().slice(0, 200));
  };
  page.on('console', watchCsp);
  // Workers take their CSP from response headers and report violations in their
  // own console, which the page's listener never sees.
  page.on('worker', (worker) => worker.on('console', watchCsp));

  const row = { pair: `${fixture.split('.').pop()} → ${target}`, label, ok: false, note: '' };

  const expected = engineOf(label);
  if (expected === 'ffmpeg') {
    await page.addInitScript(() => {
      delete window.VideoEncoder;
      delete window.AudioEncoder;
    });
  }
  let coreFetched = false;
  page.on('request', (r) => /ffmpeg-core\.wasm/.test(r.url()) && (coreFetched = true));

  try {
    // Not domcontentloaded: the file input is in the static HTML, so setInputFiles
    // succeeds before hydration wires up onChange and the drop is silently lost.
    await page.goto(APP, { waitUntil: 'networkidle' });
    // COOP + COEP must hold on every page, or SharedArrayBuffer (and with it
    // the multi-threaded FFmpeg core) silently disappears.
    if (!(await page.evaluate(() => crossOriginIsolated))) {
      row.note = 'page is not cross-origin isolated';
      results.push(row);
      await page.close();
      continue;
    }
    await page.setInputFiles('input[type="file"]:not([webkitdirectory])', join(DIR, fixture));
    await page.waitForSelector('[role="listitem"]', { timeout: 15000 });

    const select = page.locator('select[aria-label="Target format"]').first();
    const options = await select.locator('option').evaluateAll((els) => els.map((e) => e.value));
    if (!options.includes(target)) {
      row.note = `target not offered (has: ${options.join(',')})`;
      results.push(row);
      await page.close();
      continue;
    }
    await select.selectOption(target);

    await page.locator(`button[aria-label^="CONVERT →"]`).first().click();

    const done = page.locator('button[aria-label="DOWNLOAD"]').first();
    const failed = page.locator('button[aria-label="RETRY"]').first();
    await Promise.race([
      done.waitFor({ state: 'visible', timeout: 240000 }),
      failed.waitFor({ state: 'visible', timeout: 240000 }),
    ]);

    if (await failed.isVisible()) {
      row.note =
        (await page
          .locator('p.text-\\[var\\(--error\\)\\]')
          .first()
          .textContent()
          .catch(() => null)) ??
        consoleErrors[0] ??
        'conversion errored';
      const detail = await page
        .locator('[role="alert"] details code')
        .first()
        .textContent()
        .catch(() => null);
      if (detail) row.note += ' | detail: ' + detail.slice(0, 180);
      if (networkErrors.length) row.note += ' | network: ' + networkErrors.slice(0, 2).join(' | ');
      results.push(row);
      await page.close();
      continue;
    }

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      done.click(),
    ]);
    const bytes = readFileSync(await download.path());
    // SMOKE_SAVE_DIR keeps each output, e.g. to run epubcheck on what a real
    // browser produced.
    if (process.env.SMOKE_SAVE_DIR) {
      writeFileSync(join(process.env.SMOKE_SAVE_DIR, download.suggestedFilename()), bytes);
    }

    if (cspViolations.length) row.note = `CSP: ${cspViolations[0]}`;
    else if (EXPECT_MT && expected === 'ffmpeg' && mtFallbacks.length)
      row.note = mtFallbacks[0].slice(0, 200);
    else if (expected === 'ffmpeg' && !coreFetched) row.note = 'ffmpeg core was never loaded';
    else if (expected === 'webcodecs' && coreFetched) row.note = 'fell back to ffmpeg';
    else if (bytes.length === 0) row.note = 'empty output';
    else if (!(await check(bytes)))
      row.note = `bad signature (${bytes.length}B, starts ${bytes.subarray(0, 8).toString('hex')})`;
    else {
      row.ok = true;
      row.note = `${bytes.length}B → ${download.suggestedFilename()}`;
    }
  } catch (err) {
    row.note = `${err.message.split('\n')[0]}${consoleErrors.length ? ` | ${consoleErrors[0]}` : ''}`;
  }

  results.push(row);
  await page.close();
}

// Merge: a batch action, not a pair. Three files through the toolbar button,
// in list order, must come back as one PDF with a page each.
{
  const row = { pair: 'pdf+png+pdf', label: 'merge into PDF', ok: false, note: '' };
  const page = await browser.newPage({ locale: 'en-US' });
  try {
    await page.goto(APP, { waitUntil: 'networkidle' });
    await page.setInputFiles(
      'input[type="file"]:not([webkitdirectory])',
      ['doc.pdf', 'img.png', 'blue.pdf'].map((f) => join(DIR, f)),
    );
    await page.waitForSelector('[role="listitem"]');
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      page.locator('button[aria-label="MERGE INTO PDF"]').click(),
    ]);
    const bytes = readFileSync(await download.path());
    const { PDFDocument } = await import('pdf-lib');
    const pages = (await PDFDocument.load(bytes)).getPageCount();
    row.ok = pages === 3;
    row.note = `${bytes.length}B, ${pages} pages → ${download.suggestedFilename()}`;
  } catch (err) {
    row.note = err.message.split('\n')[0];
  }
  results.push(row);
  await page.close();
}

// Time to first conversion (review §9): a cold page (fresh context, nothing
// cached), one PNG → WebP. Measured from the user's side: file added → card
// shown, and Convert pressed → download ready, which includes fetching and
// starting the worker and the codec. Playwright's own wait for the button's
// entry animation is not counted.
{
  const BUDGET = { card: 1000, convert: 2000 };
  const row = { pair: 'png → webp', label: 'cold, timed', ok: false, note: '' };
  const page = await browser.newPage({ locale: 'en-US' });
  try {
    await page.goto(APP, { waitUntil: 'networkidle' });
    let start = Date.now();
    await page.setInputFiles('input[type="file"]:not([webkitdirectory])', join(DIR, 'img.png'));
    const card = page.locator('[role="listitem"]').first();
    await card.waitFor();
    const cardMs = Date.now() - start;
    await card.locator('select[aria-label="Target format"]').selectOption('webp');
    const convert = card.locator('button[aria-label^="CONVERT →"]');
    await convert.click({ trial: true }); // waits until it can be clicked
    start = Date.now();
    await convert.click();
    await card.locator('button[aria-label="DOWNLOAD"]').waitFor({ timeout: 30000 });
    const convertMs = Date.now() - start;
    row.ok = cardMs <= BUDGET.card && convertMs <= BUDGET.convert;
    row.note = `card ${cardMs} ms (≤ ${BUDGET.card}), convert ${convertMs} ms (≤ ${BUDGET.convert})`;
  } catch (err) {
    row.note = err.message.split('\n')[0];
  }
  results.push(row);
  await page.close();
}

await browser.close();

console.log(`\n=== ${engine} ===`);
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.pair.padEnd(14)} ${r.label.padEnd(16)} ${r.note}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
