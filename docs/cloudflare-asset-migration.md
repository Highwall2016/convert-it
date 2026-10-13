# Cloudflare-Owned Convert-it FFmpeg Assets

Updated 2026-10-13. This is a hardened fork; do not use the upstream publisher's CDN for executable WebAssembly.

## Provisioned infrastructure

| Component                     | Value                                                           |
| ----------------------------- | --------------------------------------------------------------- |
| R2 bucket                     | `convert-it-assets-highwall` (APAC, Standard)                   |
| Public R2 hostname            | `convert-assets.highwall-lab.us.ci`                             |
| Intended Pages hostname       | `convert-it.pages.dev` (staging)                                |
| Reserved user-facing hostname | `convert.highwall-lab.us.ci`                                    |
| ST asset base                 | `https://convert-assets.highwall-lab.us.ci/ffmpeg-core/0.12.10` |
| CORS configuration            | `r2-cors.json`                                                  |
| MT core                       | Not uploaded; do not enable `NEXT_PUBLIC_FFMPEG_MT_BASE_URL`    |

## Verified objects

| Object                                 |    Bytes | SHA-256                                                            |
| -------------------------------------- | -------: | ------------------------------------------------------------------ |
| `ffmpeg-core/0.12.10/ffmpeg-core.js`   |   112059 | `b266ab5b952555881dd6310663986994a182acb2b7ff25cf10a25f7a37ac2b21` |
| `ffmpeg-core/0.12.10/ffmpeg-core.wasm` | 32232419 | `9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7` |

The source was checked before upload; downloaded R2 objects independently match the hash pins in `lib/audio-video-converters.ts`. Both return expected Content-Type, immutable caching and read-only CORS headers for the test origin. Temporary import Worker and host-side source files were removed after import.

## Mandatory CI gate

```sh
node scripts/check-ffmpeg-st.mjs https://convert-assets.highwall-lab.us.ci/ffmpeg-core/0.12.10
```

The check fetches objects via HTTPS, asserts their SHA-256 and verifies R2 CORS for `https://convert-it.pages.dev`. Browser FFmpeg loading independently re-hashes content at runtime.

## Operational guardrails

- Configure Pages build-time `NEXT_PUBLIC_FFMPEG_BASE_URL` to use the owned R2 hostname.
- Never allow unsigned or unpinned remote script/WASM execution.
- Do not enable multi-threaded FFmpeg until all three objects match their pinned hashes and COOP/COEP plus CORS are verified.
- Avoid creating buckets, cache policies, or public URLs for user documents: file conversion should remain **browser-only**, with no upload service.
- Validate staging Pages output, CSP, CORS, browser egress and offline PWA before assigning the production custom domain.
- Keep direct-upload Github deploy secrets disabled when using native Cloudflare Pages Git integration; do not have two independent release channels.
- Restrict production deployments to reviewed, CI-passing commits, and retain rollback procedure.
