// Post-build: gives the static export a Content-Security-Policy and caching
// headers. Runs automatically after `npm run build` (the `postbuild` script).
//
// A converter parses untrusted files all day, so CSP is the defence in depth
// that matters most here. Above all connect-src: even if something in a hostile
// file ever ran, it could not send your files anywhere. Two policies, both
// enforced by the browser; content has to satisfy each one:
//
//  1. out/_headers (Cloudflare Pages) — the site-wide policy: where scripts,
//     wasm, workers, fetches and images may come from, plus framing and the
//     other security headers. It also covers the Web Workers, which take their
//     policy from HTTP headers, not from the page.
//
//  2. A <meta> CSP injected into every page that lists the SHA-256 of each of
//     that page's inline scripts. Next.js emits several per page (theme
//     bootstrap, JSON-LD, RSC payload pushes), and they differ per page, so
//     they are hashed here rather than kept by hand. The header policy has to
//     allow 'unsafe-inline' for those scripts to run at all; because the meta
//     policy lists hashes, only these exact scripts get through, and any
//     injected inline script is still blocked.
//
// The FFmpeg core origins (connect-src) come from NEXT_PUBLIC_FFMPEG_BASE_URL
// and NEXT_PUBLIC_FFMPEG_MT_BASE_URL, the same variables the bundle is built
// with, so the policy can't drift from them.
//
// COOP same-origin + COEP require-corp make every page cross-origin isolated,
// which is what exposes SharedArrayBuffer to the multi-threaded FFmpeg core.
// Every subresource is same-origin except the core, which is fetched with CORS
// (the bucket already allows it), so nothing needs a CORP header.

import { createHash } from 'node:crypto';
import nextEnv from '@next/env';
const { loadEnvConfig } = nextEnv;
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Pages build variables may be absent in Git-connected projects. Read the
// committed public production env consistently across Next and postbuild.
loadEnvConfig(process.cwd(), false);
const OUT = join(process.cwd(), 'out');

function originOf(name) {
  const base = process.env[name];
  if (!base) return null;
  try {
    return new URL(base).origin;
  } catch {
    throw new Error(`${name} is not a URL: ${base}`);
  }
}

function assetOrigin() {
  // NEXT_PUBLIC_ASSET_BASE may move the codec wasm to a CDN; default is /wasm.
  const base = process.env.NEXT_PUBLIC_ASSET_BASE;
  if (!base || base.startsWith('/')) return null;
  return new URL(base).origin;
}

function directives(extraScript = []) {
  const ffmpeg = originOf('NEXT_PUBLIC_FFMPEG_BASE_URL');
  const ffmpegMt = originOf('NEXT_PUBLIC_FFMPEG_MT_BASE_URL');
  const assets = assetOrigin();
  const remote = [...new Set([ffmpeg, ffmpegMt, assets].filter(Boolean))];
  return {
    'default-src': ["'self'"],
    // wasm-unsafe-eval: WebAssembly.instantiate for every codec, without
    // allowing JS eval. No CDN here: the FFmpeg core is fetched (connect-src),
    // hash-checked, and handed to its worker as a blob: URL.
    'script-src': ["'self'", "'wasm-unsafe-eval'", ...extraScript],
    'worker-src': ["'self'", 'blob:'],
    // Codec wasm, the font and the FFmpeg core are fetched; results are blob: URLs.
    'connect-src': ["'self'", 'blob:', 'data:', ...remote],
    'img-src': ["'self'", 'blob:', 'data:'],
    'media-src': ["'self'", 'blob:'],
    // React style props and framer-motion write inline styles.
    'style-src': ["'self'", "'unsafe-inline'"],
    'font-src': ["'self'", 'data:'],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
  };
}

function serialize(policy) {
  return Object.entries(policy)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

function htmlFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...htmlFiles(path));
    else if (name.endsWith('.html')) files.push(path);
  }
  return files;
}

// Inline <script> without src. Script content is raw text in HTML (no entity
// decoding), so the bytes between the tags are exactly what the browser hashes.
const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;

function hashInlineScripts(html) {
  const hashes = new Set();
  for (const [, body] of html.matchAll(INLINE_SCRIPT)) {
    if (!body) continue;
    hashes.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return [...hashes];
}

function injectMetaCsp(file) {
  const html = readFileSync(file, 'utf8');
  if (html.includes('http-equiv="Content-Security-Policy"')) {
    throw new Error(`${relative(OUT, file)} already has a CSP meta tag — build output reused?`);
  }
  const hashes = hashInlineScripts(html);
  // script-src here, plus worker-src so it doesn't fall back to script-src:
  // mediabunny (the WebCodecs path) starts small blob: workers from the page.
  // A blob: worker can only be made by a script already allowed to run, and
  // has no DOM, so page scripts still can't be loaded from blob:. The header
  // policy carries everything else; frame-ancestors is ignored in a meta.
  const policy = [
    `script-src ${directives(hashes)['script-src'].join(' ')}`,
    `worker-src ${directives()['worker-src'].join(' ')}`,
  ].join('; ');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}"/>`;
  // The meta must come before the first script it governs, so it goes first in <head>.
  const at = html.indexOf('<head>');
  if (at === -1) throw new Error(`${relative(OUT, file)} has no <head>`);
  const insert = at + '<head>'.length;
  writeFileSync(file, html.slice(0, insert) + meta + html.slice(insert));
  return hashes.length;
}

function headersFile() {
  // blob: lets the FFmpeg worker import its verified core. It is only in this
  // policy (the one workers get); pages also carry the meta policy without
  // blob:, so a page can't run a blob: script.
  const headerPolicy = directives(["'unsafe-inline'", 'blob:']);
  headerPolicy['frame-ancestors'] = ["'none'"];

  return `# Generated by scripts/security-headers.mjs — do not edit in out/.
/*
  Content-Security-Policy: ${serialize(headerPolicy)}
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()

# The service worker and its manifest must always be revalidated, or browsers
# keep running an old worker long after a deploy.
/sw.js
  Cache-Control: no-cache
/offline-pack.json
  Cache-Control: no-cache

# Content-hashed by Next.js: safe to cache forever.
/_next/static/*
  Cache-Control: public, max-age=31536000, immutable

# Stable names (not content-hashed), so cache for a day and revalidate in the
# background rather than forever. A codec upgrade still lands within a day.
/wasm/*
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800
/ocr/*
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800
/fonts/*
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800
`;
}

if (!originOf('NEXT_PUBLIC_FFMPEG_BASE_URL')) {
  console.warn(
    '[security-headers] NEXT_PUBLIC_FFMPEG_BASE_URL is unset: the CSP will not allow the FFmpeg core.',
  );
}

let pages = 0;
let scripts = 0;
for (const file of htmlFiles(OUT)) {
  scripts += injectMetaCsp(file);
  pages++;
}
writeFileSync(join(OUT, '_headers'), headersFile());
console.log(
  `[security-headers] CSP meta in ${pages} pages (${scripts} inline script hashes), wrote out/_headers`,
);
