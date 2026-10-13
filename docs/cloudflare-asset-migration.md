# Cloudflare-Owned Convert-it FFmpeg Assets

Updated 2026-10-13. This is a hardened fork; do not use the upstream publisher's CDN for executable WebAssembly.

## Provisioned infrastructure

| Component                     | Value                                                           |
| ----------------------------- | --------------------------------------------------------------- |
| R2 bucket                     | `convert-it-assets-highwall` (APAC, Standard)                   |
| Public R2 hostname            | `convert-assets.highwall-lab.us.ci`                             |
| Intended Pages hostname       | `convert-it-8wh.pages.dev` (staging)                            |
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

The check fetches objects via HTTPS, asserts their SHA-256 and verifies R2 CORS for `https://convert-it-8wh.pages.dev`. Browser FFmpeg loading independently re-hashes content at runtime.

## Operational guardrails

- Configure Pages build-time `NEXT_PUBLIC_FFMPEG_BASE_URL` to use the owned R2 hostname.
- Never allow unsigned or unpinned remote script/WASM execution.
- Do not enable multi-threaded FFmpeg until all three objects match their pinned hashes and COOP/COEP plus CORS are verified.
- Avoid creating buckets, cache policies, or public URLs for user documents: file conversion should remain **browser-only**, with no upload service.
- Validate staging Pages output, CSP, CORS, browser egress and offline PWA before assigning the production custom domain.
- Pages now uses native Git integration, with production_branch=feat/cloudflare-owned-ffmpeg only for staging. The former GitHub token-based deployment step is removed, preventing duplicate release channels. Use reviewed main after merging both security PRs.
- Restrict production deployments to reviewed, CI-passing commits, and retain rollback procedure.

## Cloudflare Pages build reproducibility

Cloudflare Pages Git integration may not expose the project-defined build variables
to the Git builder (a first build logged `Build environment variables: (none found)`).
This fork therefore commits **only a public CDN URL** in `.env.production`, and the
Node post-build header/PWA generators explicitly load it with `@next/env`.
`scripts/check-build-config.mjs` runs as part of `npm run postbuild` and
**fails the build** unless the emitted JS, Service Worker and CSP all contain
the exact owned R2 origin. Do not put secrets in `.env.production`.

The Pages project uses native Git integration; previews are disabled and the
temporary production branch is `feat/cloudflare-owned-ffmpeg` while testing.
Do not bind the human-facing custom domain until live E2E, egress and CSP
checks pass, and switch the protected production branch to `main` only after
the hardened security PRs have been reviewed and merged.
