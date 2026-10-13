import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import type { ConversionSettings } from './types';
import { getFormatInfo, mimeFor } from './formats';
import { ConversionError } from './errors';
import { isCjk, isHangul } from './scripts';
import { cancelWebCodecs, convertWithWebCodecs } from './webcodecs-converter';

// Self-hosted on R2 rather than unpkg: a third-party CDN is both a single point of
// failure and an unsigned-wasm supply-chain hole, and Cloudflare Pages rejects files
// over 25MiB so the 31MB core cannot live in public/. Set this to the R2 custom domain
// (not the rate-limited *.r2.dev URL) and allow the Pages origin in the bucket's CORS.
// Inlined at build time by the static export, so a rebuild is needed to change it.
const FFMPEG_BASE_URL = process.env.NEXT_PUBLIC_FFMPEG_BASE_URL;

// Optional: where @ffmpeg/core-mt's three files live (same bucket, its own
// directory, since the file names are the same). Unset, media always runs on
// the single-threaded core.
const FFMPEG_MT_BASE_URL = process.env.NEXT_PUBLIC_FFMPEG_MT_BASE_URL;

// SHA-256 of @ffmpeg/core@0.12.10 dist/umd, the build uploaded to R2. The core
// is 31 MB of code fetched cross-origin at runtime, so it is checked before it
// runs: a tampered or swapped file on the CDN fails loudly instead of executing
// with access to the user's files. After a core upgrade, regenerate with
// `sha256sum node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.{js,wasm}`.
export const FFMPEG_CORE_SHA256 = {
  'ffmpeg-core.js': 'b266ab5b952555881dd6310663986994a182acb2b7ff25cf10a25f7a37ac2b21',
  'ffmpeg-core.wasm': '9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7',
} as const;

// Same for @ffmpeg/core-mt@0.12.10 dist/umd (`npm pack @ffmpeg/core-mt@0.12.10`).
export const FFMPEG_CORE_MT_SHA256 = {
  'ffmpeg-core.js': '62f5f5f468a37861da12c4581c321bb5ca8ba2f7b776377e08dd2ab72de293f9',
  'ffmpeg-core.wasm': 'be2c97605366b78f3f13e21b52e81a55a79e1f29c133b03a68ec187b1a2ec41a',
  'ffmpeg-core.worker.js': '97322a227c5f3d5ccfd0d0825890a6deeba137106a09b633ca75cadf49ddd2cb',
} as const;

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  // Digest a view, not the bare buffer: every WebCrypto accepts a Uint8Array,
  // while Node 20's rejects an ArrayBuffer from another realm (fetch under
  // jsdom), which is where the tests run.
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fetches one core file, checks it against the pinned hash, and returns a blob:
 * URL of the verified bytes. The worker loads that blob, not the network URL,
 * so what runs is exactly what was checked; there is no second fetch that
 * could return something else.
 */
// Immutable hash-pinned assets can be fetched again after transient network
// errors. Do not retry 4xx (except 429), and never retry an integrity mismatch.
const TRANSIENT_HTTP = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [250, 750];

class TransientCoreFetchError extends Error {}

/** Retrieve an executable core asset, retrying transient network/read errors. */
export async function fetchCoreBytesWithRetry(url: string): Promise<ArrayBuffer> {
  const filename = new URL(url).pathname.split('/').pop() || 'FFmpeg core';
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const message = filename + ': HTTP ' + res.status;
        if (TRANSIENT_HTTP.has(res.status)) throw new TransientCoreFetchError(message);
        throw new Error(message);
      }
      return await res.arrayBuffer();
    } catch (err) {
      if (
        attempt === RETRY_DELAYS_MS.length ||
        !(err instanceof TypeError || err instanceof TransientCoreFetchError)
      ) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
  throw new Error(filename + ': exhausted retry attempts');
}

async function verifiedBlobUrl(
  base: string,
  name: string,
  expected: string,
  type: string,
): Promise<string> {
  const data = await fetchCoreBytesWithRetry(base + '/' + name);
  if ((await sha256Hex(data)) !== expected) {
    throw new Error(name + ' failed its integrity check — refusing to run it');
  }
  return URL.createObjectURL(new Blob([data], { type }));
}

/**
 * Whether to try the multi-threaded core. It needs SharedArrayBuffer, which
 * browsers only expose to cross-origin isolated pages (COOP + COEP in
 * _headers), and it reserves 1 GiB of shared memory and a pool of 32 threads
 * up front, so small devices stay on the single-threaded core. deviceMemory
 * is Chromium-only; elsewhere a failed load falls back instead.
 */
export function multiThreadEligible(env: {
  isolated: boolean;
  cores: number;
  memoryGb?: number;
}): boolean {
  return env.isolated && env.cores >= 4 && (env.memoryGb === undefined || env.memoryGb >= 4);
}

function browserEnv() {
  const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
  return {
    isolated: globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function',
    cores: nav?.hardwareConcurrency ?? 1,
    memoryGb: nav?.deviceMemory,
  };
}

type CoreMode = 'mt' | 'st';

let ffmpeg: FFmpeg | null = null;
let ffmpegMode: CoreMode | null = null;
let ffmpegLoading: Promise<FFmpeg> | null = null;
// Set once the multi-threaded core fails to load or crashes; the rest of the
// session uses the single-threaded one.
let multiThreadBroken = false;
// Blob URLs the live instance still needs (see loadCore).
let pinnedUrls: string[] = [];

async function loadCore(mode: CoreMode): Promise<FFmpeg> {
  const base = (mode === 'mt' ? FFMPEG_MT_BASE_URL : FFMPEG_BASE_URL)!;
  const hashes: Record<string, string> = mode === 'mt' ? FFMPEG_CORE_MT_SHA256 : FFMPEG_CORE_SHA256;
  const file = (name: string, type: string) => verifiedBlobUrl(base, name, hashes[name], type);
  const urls: string[] = [];
  let ff: FFmpeg | undefined;
  try {
    const [coreURL, wasmURL, workerURL] = await Promise.all([
      file('ffmpeg-core.js', 'text/javascript'),
      file('ffmpeg-core.wasm', 'application/wasm'),
      mode === 'mt' ? file('ffmpeg-core.worker.js', 'text/javascript') : undefined,
    ]);
    urls.push(coreURL, wasmURL, ...(workerURL ? [workerURL] : []));
    ff = new FFmpeg();
    await ff.load({ coreURL, wasmURL, workerURL });
    // The compiled wasm is handed to every thread, so its 32 MB blob can go.
    // A thread started after load imports the core JS and the thread script
    // by URL, so the multi-threaded core keeps those two (130 KB) alive.
    URL.revokeObjectURL(wasmURL);
    if (workerURL) pinnedUrls = [coreURL, workerURL];
    else URL.revokeObjectURL(coreURL);
    return ff;
  } catch (err) {
    ff?.terminate();
    for (const url of urls) URL.revokeObjectURL(url);
    throw err;
  }
}

// A failed load is not remembered: the next conversion tries again. Caching the
// error meant one flaky fetch of the 31 MB core disabled audio and video until
// the page was reloaded.
async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg;
  if (ffmpegLoading) return ffmpegLoading;

  ffmpegLoading = (async () => {
    try {
      if (!FFMPEG_BASE_URL) {
        throw new Error('NEXT_PUBLIC_FFMPEG_BASE_URL is not set');
      }
      if (FFMPEG_MT_BASE_URL && !multiThreadBroken && multiThreadEligible(browserEnv())) {
        try {
          ffmpeg = await loadCore('mt');
          ffmpegMode = 'mt';
          return ffmpeg;
        } catch (err) {
          multiThreadBroken = true;
          console.warn('Multi-threaded FFmpeg did not load; using the single-threaded core.', err);
        }
      }
      ffmpeg = await loadCore('st');
      ffmpegMode = 'st';
      return ffmpeg;
    } catch (err) {
      ffmpegLoading = null;
      throw new Error(`Failed to load FFmpeg: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();

  return ffmpegLoading;
}

/** The core the live instance runs, if one is loaded. */
export function ffmpegCoreMode(): CoreMode | null {
  return ffmpegMode;
}

// One FFmpeg instance backs every job, and every job writes to the same
// input.<ext> / output.<ext> pair in its virtual FS. "Convert all" fires jobs
// concurrently, so without this queue two videos would overwrite each other's
// files mid-exec and both come back wrong. Serialising also matches what the
// single wasm heap can actually do.
let ffmpegQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const run = ffmpegQueue.then(work, work);
  ffmpegQueue = run.catch(() => {});
  return run;
}

function dropInstance(): void {
  ffmpeg?.terminate();
  ffmpeg = null;
  ffmpegMode = null;
  ffmpegLoading = null;
  for (const url of pinnedUrls) URL.revokeObjectURL(url);
  pinnedUrls = [];
}

/**
 * Kills the shared instance (and cancels a WebCodecs job in flight). wasm
 * cannot be interrupted, so this is the only way to stop an exec; the next
 * conversion reloads the core.
 */
export function terminateFFmpeg(): void {
  cancelWebCodecs();
  dropInstance();
  ffmpegQueue = Promise.resolve();
}

function getCategory(sourceExt: string): 'video' | 'audio' | null {
  const category = getFormatInfo(sourceExt)?.category;
  return category === 'video' || category === 'audio' ? category : null;
}

// Audio-only outputs. `bitrate: false` marks the lossless codecs, which take no
// -b:a and must not be resampled.
export const AUDIO_CODECS: Record<string, { codec: string; bitrate: boolean }> = {
  mp3: { codec: 'libmp3lame', bitrate: true },
  wav: { codec: 'pcm_s16le', bitrate: false },
  aac: { codec: 'aac', bitrate: true },
  ogg: { codec: 'libvorbis', bitrate: true },
  flac: { codec: 'flac', bitrate: false },
  m4a: { codec: 'aac', bitrate: true },
};

// libvpx has no -preset; its speed knob is -cpu-used, 0 (slowest) … 5 at the
// "good" deadline.
const VP8_CPU_USED: Record<string, string> = {
  ultrafast: '5',
  superfast: '5',
  veryfast: '4',
  faster: '3',
  fast: '2',
  medium: '2',
  slow: '1',
  slower: '0',
  veryslow: '0',
};

// libvpx's CRF runs 4–63 (VP8 default 10) against x264's 0–51 (default 23).
// This keeps the slider's "lower is better" meaning: CRF 23 → 28, 18 → 22.
function crfToVp8(crf: number): string {
  return String(Math.min(63, Math.max(4, Math.round(crf * 1.2))));
}

// mpeg4 (AVI) and Sorenson (FLV) are not CRF encoders; they take a fixed
// quantiser, 1 (best) … 31. This maps the CRF slider onto it so the same
// setting still means "better" or "smaller": CRF 23 → q 5, CRF 51 → q 11.
function crfToQscale(crf: number): string {
  return String(Math.min(31, Math.max(1, Math.round(crf / 4.5))));
}

// The settings a command line can use, read only when a codec asks for one
// (getters): registry.test records which fields each route reads, and a
// setting the panel shows must be one the conversion actually uses.
interface Knobs {
  readonly crf: number;
  readonly preset: string;
  readonly kbps: number;
}

function knobsFrom(settings?: Partial<ConversionSettings>): Knobs {
  return {
    // `??`, not `||`: CRF 0 is lossless, not "unset".
    get crf() {
      return settings?.videoQuality ?? 23;
    },
    get preset() {
      return settings?.videoPreset || 'medium';
    },
    get kbps() {
      return settings?.audioBitrate ?? 192;
    },
  };
}

interface VideoContainer {
  video: (k: Knobs) => string[];
  // Each muxer only accepts some audio codecs; WebM, for one, rejects AAC outright.
  audio: (k: Knobs) => string[];
  extra?: string[];
}

const x264 = (k: Knobs) => [
  '-c:v',
  'libx264',
  '-preset',
  k.preset,
  '-crf',
  String(k.crf),
  // 10-bit or 4:4:4 sources otherwise come out as High 4:4:4 H.264, which
  // browsers and QuickTime refuse to play.
  '-pix_fmt',
  'yuv420p',
];
const aac = (k: Knobs) => ['-c:a', 'aac', '-b:a', `${k.kbps}k`];
const mp3 = (k: Knobs) => ['-c:a', 'libmp3lame', '-b:a', `${k.kbps}k`, '-ar', '44100'];

const VIDEO_CONTAINERS: Record<string, VideoContainer> = {
  mp4: { video: x264, audio: aac, extra: ['-movflags', '+faststart'] },
  mov: { video: x264, audio: aac, extra: ['-movflags', '+faststart'] },
  mkv: { video: x264, audio: aac },
  // VP8 + Vorbis, not VP9 + Opus. In @ffmpeg/core 0.12.10 libvpx-vp9 dies with
  // "memory access out of bounds" on every input, and libopus does the same on
  // any stereo source at its default complexity (a MediaRecorder clip is
  // enough). Both reproduced in Chromium and Node against the same wasm. VP8 and
  // Vorbis encode cleanly, both are valid WebM, and every browser plays them.
  // In constrained-quality mode -b:v is only a ceiling; CRF decides the quality.
  webm: {
    video: (k) => [
      '-c:v',
      'libvpx',
      '-crf',
      crfToVp8(k.crf),
      '-b:v',
      '4M',
      '-deadline',
      'good',
      '-cpu-used',
      VP8_CPU_USED[k.preset] ?? '2',
      '-pix_fmt',
      'yuv420p',
    ],
    audio: (k) => ['-c:a', 'libvorbis', '-b:a', `${k.kbps}k`],
  },
  // Fixed-quantiser encoders: no speed preset to offer.
  avi: { video: (k) => ['-c:v', 'mpeg4', '-q:v', crfToQscale(k.crf)], audio: mp3 },
  flv: { video: (k) => ['-c:v', 'flv', '-q:v', crfToQscale(k.crf)], audio: mp3 },
};

/**
 * Input options for a trim: -ss seeks before decoding (fast, and frame-exact
 * when re-encoding), -t caps the length read from there. An end at or before
 * the start means "to the end".
 */
export function trimArgs(settings?: Partial<ConversionSettings>): string[] {
  const start = Math.max(0, settings?.trimStart ?? 0);
  const end = settings?.trimEnd ?? 0;
  const args: string[] = [];
  if (start > 0) args.push('-ss', String(start));
  if (end > start) args.push('-t', String(+(end - start).toFixed(3)));
  return args;
}

/**
 * The section to cut out, in the trimmed clip's timeline (-ss restarts it at
 * 0). The settings give it in the source's own time, like the trim.
 */
export function cutRange(settings?: Partial<ConversionSettings>): [number, number] | null {
  const from = settings?.cutStart ?? 0;
  const to = settings?.cutEnd ?? 0;
  if (!(to > from)) return null;
  const offset = Math.max(0, settings?.trimStart ?? 0);
  const a = +Math.max(0, from - offset).toFixed(3);
  const b = +(to - offset).toFixed(3);
  return b > a ? [a, b] : null;
}

/** Subtitle burn-in: the files runMedia writes into ffmpeg's filesystem. */
export const BURN = { subtitles: 'burn.ass', fontsDir: '/fonts' } as const;

/**
 * Video filters that come before any scaling: burnt-in subtitles first (their
 * times are the trimmed clip's), then the cut. The cut drops the frames in
 * [a, b] and moves everything after it back by b - a, which keeps variable
 * frame rates intact (N/FRAME_RATE/TB would not).
 */
function videoPre(settings?: Partial<ConversionSettings>): string[] {
  const filters: string[] = [];
  // The style and per-script fonts are in the ASS file itself (toAss).
  if (settings?.subtitleFile) {
    filters.push(`subtitles=filename=${BURN.subtitles}:fontsdir=${BURN.fontsDir}`);
  }
  const cut = cutRange(settings);
  if (cut) {
    const [a, b] = cut;
    filters.push(
      `select='not(between(t,${a},${b}))'`,
      `setpts='PTS-gte(T,${b})*${+(b - a).toFixed(3)}/TB'`,
    );
  }
  return filters;
}

/** The audio side of the cut: audio runs at a fixed sample rate, so N/SR/TB is exact. */
function audioCut(settings?: Partial<ConversionSettings>): string[] {
  const cut = cutRange(settings);
  if (!cut) return [];
  return ['-af', `aselect='not(between(t,${cut[0]},${cut[1]}))',asetpts=N/SR/TB`];
}

/** fps and width for animated output; width 0 keeps the source width. */
function animationFilter(settings?: Partial<ConversionSettings>): string {
  const fps = settings?.animFps || 12;
  const width = settings?.animWidth ?? 480;
  // Only ever scale down; -2 keeps the height even, which libwebp requires.
  const scale = width > 0 ? `,scale='min(${width},iw)':-2:flags=lanczos` : '';
  return `fps=${fps}${scale}`;
}

/**
 * The ffmpeg command line for one conversion. Pure, so the per-container codec
 * choices are testable without loading the 31 MB core.
 */
export function buildFfmpegArgs(
  sourceExt: string,
  targetExt: string,
  inputName: string,
  outputName: string,
  settings?: Partial<ConversionSettings>,
): string[] {
  const category = getCategory(sourceExt);
  if (!category) throw new Error(`Unsupported file type: ${sourceExt}`);

  const k = knobsFrom(settings);
  const input = [...trimArgs(settings), '-i', inputName];
  const cutAudio = audioCut(settings);

  const audioTarget = AUDIO_CODECS[targetExt];
  if (audioTarget) {
    // -vn also drops embedded cover art, which ogg and wav can't carry anyway.
    const args = [...input, '-vn', ...cutAudio, '-c:a', audioTarget.codec];
    if (audioTarget.bitrate) args.push('-b:a', `${k.kbps}k`, '-ar', '44100');
    return [...args, '-y', outputName];
  }

  if (category === 'video' && targetExt === 'gif') {
    // One pass, two branches: palettegen builds a 256-colour palette from the
    // whole clip, paletteuse maps every frame onto it. Without it GIF gets
    // the generic web palette and banding. diff_mode=rectangle re-dithers
    // only what changed between frames, which keeps static areas from
    // shimmering and the file smaller.
    const filter =
      [...videoPre(settings), animationFilter(settings)].join(',') +
      ',split[a][b];[a]palettegen=stats_mode=diff[p];' +
      '[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle';
    return [...input, '-filter_complex', filter, '-loop', '0', '-y', outputName];
  }

  if (category === 'video' && targetExt === 'webp') {
    return [
      ...input,
      '-vf',
      [...videoPre(settings), animationFilter(settings)].join(','),
      '-c:v',
      'libwebp',
      '-loop',
      '0',
      '-lossless',
      '0',
      '-q:v',
      '75',
      '-an',
      '-y',
      outputName,
    ];
  }

  const container = category === 'video' ? VIDEO_CONTAINERS[targetExt] : undefined;
  if (!container) throw new Error(`Unsupported conversion: ${sourceExt} → ${targetExt}`);

  // Resize: only ever down, keeping the aspect ratio and an even height
  // (x264 and libvpx need even dimensions). Mute drops the audio stream.
  const maxWidth = settings?.videoMaxWidth ?? 0;
  const video = [
    ...videoPre(settings),
    ...(maxWidth > 0 ? [`scale='min(${maxWidth},iw)':-2`] : []),
  ];
  return [
    ...input,
    ...(video.length ? ['-vf', video.join(',')] : []),
    ...container.video(k),
    ...(settings?.mute ? ['-an'] : [...cutAudio, ...container.audio(k)]),
    ...(container.extra ?? []),
    '-y',
    outputName,
  ];
}

function parseTimestamp(h: string, m: string, s: string): number {
  return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(s);
}

/**
 * Watches ffmpeg's log for two things: progress, which is `time=` against the
 * input's `Duration:` (so a two-hour film no longer reads 95 % after ten
 * seconds), and the last few lines, which are the only useful part of an error.
 */
export function createLogWatcher(onProgress?: (pct: number) => void) {
  let duration = 0;
  const recent: string[] = [];

  const handler = ({ message }: { message: string }) => {
    recent.push(message);
    if (recent.length > 6) recent.shift();

    const d = message.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (d && !duration) duration = parseTimestamp(d[1], d[2], d[3]);

    const t = message.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (t && duration > 0) {
      const elapsed = parseTimestamp(t[1], t[2], t[3]);
      onProgress?.(Math.min(95, Math.round(10 + (elapsed / duration) * 85)));
    }
  };

  const tail = () =>
    recent
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-3)
      .join(' · ')
      .slice(0, 300);

  return { handler, tail };
}

async function runMedia(
  file: File,
  sourceExt: string,
  targetExt: string,
  settings?: ConversionSettings,
  onProgress?: (pct: number) => void,
): Promise<Blob> {
  // The browser's own codecs first; the 31 MB core is only fetched for jobs
  // they can't do.
  const fast = await convertWithWebCodecs(file, sourceExt, targetExt, settings, onProgress);
  if (fast) return fast;

  const ff = await getFFmpeg();
  const mode = ffmpegMode;
  try {
    return await execOnce(ff, file, sourceExt, targetExt, settings, onProgress);
  } catch (err) {
    // A crash (an abort or a wasm trap, not a clean non-zero exit) on the
    // multi-threaded core: retire it for the session and run the job again on
    // the single-threaded one. ffmpeg !== ff means a cancel dropped the
    // instance, which is not a crash.
    if (mode !== 'mt' || err instanceof FfmpegExitError || ffmpeg !== ff) throw err;
    console.warn('Multi-threaded FFmpeg failed; retrying on the single-threaded core.', err);
    multiThreadBroken = true;
    dropInstance();
    return execOnce(await getFFmpeg(), file, sourceExt, targetExt, settings, onProgress);
  }
}

/** FFmpeg ran to completion and reported failure: the input's fault, not the core's. */
class FfmpegExitError extends Error {}

async function execOnce(
  ff: FFmpeg,
  file: File,
  sourceExt: string,
  targetExt: string,
  settings?: ConversionSettings,
  onProgress?: (pct: number) => void,
): Promise<Blob> {
  const inputName = `input.${sourceExt}`;
  const outputName = `output.${targetExt}`;

  const log = createLogWatcher(onProgress);
  ff.on('log', log.handler);
  try {
    await prepareSubtitles(ff, settings);
    const args = buildFfmpegArgs(sourceExt, targetExt, inputName, outputName, settings);
    await ff.writeFile(inputName, await fetchFile(file));
    const code = await ff.exec(args);
    // A non-zero exit leaves no output file, and readFile's "no such file"
    // told the user nothing. The log tail usually names the actual problem.
    if (code !== 0) {
      const detail = log.tail();
      throw new FfmpegExitError(
        `FFmpeg could not convert this file (exit ${code})${detail ? `: ${detail}` : ''}`,
      );
    }
    const outputData = (await ff.readFile(outputName)) as Uint8Array;
    onProgress?.(100);
    return new Blob([outputData.buffer as ArrayBuffer], {
      type: mimeFor(targetExt),
    });
  } finally {
    ff.off('log', log.handler);
    // Always clean up: a failed job used to leave up to 500 MB of input in
    // MEMFS for the next one to run out of memory on.
    await removeQuietly(ff, inputName);
    await removeQuietly(ff, outputName);
    await removeQuietly(ff, BURN.subtitles);
  }
}

// Fonts already written into this instance's filesystem (the CJK subset alone
// is 5 MB): fetched once per instance, not per job.
const fontsWritten = new WeakMap<FFmpeg, Set<string>>();

/**
 * For burn-in: the subtitles, moved by the trim so their times match the
 * trimmed clip, as an ASS file whose text names a font per script (see
 * toAss: without fontconfig, libass never falls back), plus just the Noto
 * fonts that text needs.
 */
async function prepareSubtitles(ff: FFmpeg, settings?: ConversionSettings): Promise<void> {
  const source = settings?.subtitleFile;
  if (!source) return;
  const { parseSubtitles, shift, toAss } = await import('./subtitles');
  const cues = shift(parseSubtitles(await source.text()), -Math.max(0, settings.trimStart ?? 0));
  if (!cues.length) {
    throw new ConversionError(
      'invalid-settings',
      `${source.name} has no subtitle cues in the clip (expected lines like 00:00:01,000 --> 00:00:04,000)`,
    );
  }
  const fonts = new Set(['noto-sans-regular.ttf']);
  const ass = toAss(cues, (cp) => {
    if (isHangul(cp)) {
      fonts.add('noto-sans-hangul-regular.ttf');
      return 'Noto Sans KR';
    }
    if (isCjk(cp)) {
      fonts.add('noto-sans-cjk-regular.ttf');
      return 'Noto Sans SC';
    }
    return 'Noto Sans';
  });

  const written = fontsWritten.get(ff) ?? new Set<string>();
  fontsWritten.set(ff, written);
  if (!written.size) await ff.createDir(BURN.fontsDir).catch(() => {});
  for (const font of fonts) {
    if (written.has(font)) continue;
    const res = await fetch(`${SUBTITLE_FONT_BASE}/${font}`);
    if (!res.ok) throw new ConversionError('engine-load', `${font}: HTTP ${res.status}`);
    await ff.writeFile(`${BURN.fontsDir}/${font}`, new Uint8Array(await res.arrayBuffer()));
    written.add(font);
  }
  await ff.writeFile(BURN.subtitles, new TextEncoder().encode(ass));
}

// The same Noto subsets the PDF typesetter uses.
const SUBTITLE_FONT_BASE = '/fonts/pdf';

// deleteFile rejects when the file was never written, or when a cancel already
// terminated the instance; neither is worth surfacing.
async function removeQuietly(ff: FFmpeg, path: string): Promise<void> {
  try {
    await ff.deleteFile(path);
  } catch {
    // already gone
  }
}

export function convertAudioVideo(
  file: File,
  sourceExt: string,
  targetExt: string,
  settings?: ConversionSettings,
  onProgress?: (pct: number) => void,
): Promise<Blob> {
  return enqueue(() => runMedia(file, sourceExt, targetExt, settings, onProgress));
}

// Extract audio from video. Same pipeline: buildFfmpegArgs drops the video
// stream whenever the target is an audio format.
export function extractAudio(
  file: File,
  sourceExt: string,
  targetExt: string,
  settings?: ConversionSettings,
  onProgress?: (pct: number) => void,
): Promise<Blob> {
  return enqueue(() => runMedia(file, sourceExt, targetExt, settings, onProgress));
}
