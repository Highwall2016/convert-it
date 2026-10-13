// Fail closed if anonymous HTTP requests can retrieve the protected Pages site.
// Authentication happens at Cloudflare Access, never in browser-side JS.
// Usage: node scripts/access-gate-smoke.mjs
// Optional: ACCESS_DEPLOYMENT_URL=https://<deployment>.<project>.pages.dev
const root = process.env.ACCESS_SITE_URL || 'https://convert-it-8wh.pages.dev';
const deployment = process.env.ACCESS_DEPLOYMENT_URL || 'https://5f0ebb45.convert-it-8wh.pages.dev';
const paths = ['/', '/about', '/sw.js', '/manifest.json', '/_next/static/chunks/'];
const urls = [
  ...paths.map((path) => new URL(path, root).href),
  new URL('/', deployment).href,
  // Earlier immutable Pages deployment must not bypass a newly added policy.
  'https://c09b1ba2.convert-it-8wh.pages.dev/',
];
if (process.env.ACCESS_CUSTOM_DOMAIN) {
  urls.push(new URL('/', process.env.ACCESS_CUSTOM_DOMAIN).href);
}
let failed = 0;
for (const url of urls) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'cache-control': 'no-cache', 'x-access-check': 'anonymous' },
      signal: AbortSignal.timeout(18000),
    });
    const redirect = response.headers.get('location') || '';
    const target = redirect ? new URL(redirect, url) : null;
    const accessGate =
      response.status === 302 &&
      target?.protocol === 'https:' &&
      target.hostname.endsWith('.cloudflareaccess.com') &&
      target.pathname.startsWith('/cdn-cgi/access/login/');
    if (!accessGate) {
      console.error(
        'FAIL anonymous content not gated:',
        new URL(url).hostname,
        new URL(url).pathname,
        'status=',
        response.status,
        'redirectHost=',
        target?.hostname || '(none)',
      );
      failed++;
    } else {
      console.log('PASS Access 302:', new URL(url).hostname, new URL(url).pathname);
    }
  } catch (error) {
    console.error('FAIL unable to verify Access:', new URL(url).hostname, error.message);
    failed++;
  }
}
console.log('Cloudflare Access anonymous gate checks:', urls.length - failed, '/', urls.length);
if (failed) process.exitCode = 1;
