// Post-build: writes out/sw.js from scripts/sw-template.js, and
// out/offline-pack.json (what "Save for offline use" downloads, and its size).
// Runs after security-headers.mjs, so the HTML it fingerprints is final.
import { createHash } from 'node:crypto';
import nextEnv from '@next/env';
const { loadEnvConfig } = nextEnv;
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Pages build variables may be absent in Git-connected projects. Read the
// committed public production env consistently across Next and postbuild.
loadEnvConfig(process.cwd(), false);
const OUT = join(process.cwd(), 'out');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const urlOf = (path) => `/${relative(OUT, path).split(sep).join('/')}`;
const files = walk(OUT);
const byUrl = new Map(files.map((path) => [urlOf(path), path]));

// Shell: the pages people open, plus everything their HTML references.
const pages = { '/': 'index.html', '/about': 'about.html' };
const shell = new Set(['/', '/about', '/manifest.json', '/favicon.svg']);
for (const url of byUrl.keys()) if (url.startsWith('/icons/')) shell.add(url);
for (const file of Object.values(pages)) {
  const html = readFileSync(join(OUT, file), 'utf8');
  for (const [, ref] of html.matchAll(/["'(](\/_next\/static\/[^"')?#\s]+)/g)) {
    if (byUrl.has(ref)) shell.add(ref);
  }
}

// Offline pack: every app asset. Converter landing pages are left out (the
// service worker falls back to the home converter for them).
const pack = [...byUrl.keys()]
  .filter((url) => /^\/(_next\/static|wasm|fonts|icons)\//.test(url) && !url.endsWith('.map'))
  .concat(['/', '/about', '/manifest.json', '/favicon.svg'])
  .sort();
const packBytes = pack.reduce((sum, url) => {
  const path = byUrl.get(url) ?? join(OUT, pages[url] ?? '');
  return sum + (byUrl.has(url) || pages[url] ? statSync(path).size : 0);
}, 0);

// Version: fingerprint of every file the worker can serve, so any change to
// the build installs a new worker (and drops the old shell cache).
const hash = createHash('sha256');
for (const url of [...new Set([...shell, ...pack])].sort()) {
  const path = byUrl.get(url) ?? (pages[url] && join(OUT, pages[url]));
  if (path) hash.update(url).update(readFileSync(path));
}
const version = hash.digest('hex').slice(0, 12);

const mediaOrigins = [
  ...new Set(
    [process.env.NEXT_PUBLIC_FFMPEG_BASE_URL, process.env.NEXT_PUBLIC_FFMPEG_MT_BASE_URL]
      .filter(Boolean)
      .map((base) => new URL(base).origin),
  ),
];

const template = readFileSync(join(process.cwd(), 'scripts', 'sw-template.js'), 'utf8');
const sw = template
  .replace('__VERSION__', JSON.stringify(version))
  .replace('__SHELL__', JSON.stringify([...shell].sort()))
  .replace('__PACK__', JSON.stringify(pack))
  .replace('__MEDIA_ORIGINS__', JSON.stringify(mediaOrigins));
if (/__[A-Z_]+__/.test(sw.replace(/\/\*[\s\S]*?\*\//, '')))
  throw new Error('sw.js: unfilled placeholder');

writeFileSync(join(OUT, 'sw.js'), sw);
writeFileSync(
  join(OUT, 'offline-pack.json'),
  JSON.stringify({ version, files: pack.length, bytes: packBytes }),
);
console.log(
  `[build-sw] sw.js ${version}: shell ${shell.size} files, offline pack ${pack.length} files (${(packBytes / 1048576).toFixed(1)} MB)`,
);
