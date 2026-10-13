# Convert-it Hardened Fork — Security Remediation & Validation Plan

Baseline: upstream `acchuang/convert-it` commit `68545518fc1cd497bd6dcdc623dbd5c53f7c24fd`.
Maintainer fork: `Highwall2016/convert-it`. Working branch: `security/harden-file-converters`.
Deployment default: **disabled** until Cloudflare assets, secrets and network egress policies are explicitly configured.

## Goals and non-goals

- Preserve local-only browser conversion. **Never upload user files to any conversion API.**
- Homelab persistent container requirement: **zero**; Cloudflare Pages serves only static code.
- Protect the user against malicious input exhaustion, active exported content, and unexpected remote requests.
- Pin/scope the build supply chain and deploy only passing, reviewable commits.
- Preserve current format compatibility where safe; surface deliberate limits as helpful errors.
- Do not claim that zero stars, SHA-256 validation, CSP, WASM or a green pipeline proves complete security.

## Remediation backlog / release gates

| Gate               | Risk                               | Change                                                                                  | Verification                               | Target                                                  |
| ------------------ | ---------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| P0 / code          | XLSX decompression bomb            | Bound uncompressed worksheet/XML bytes before full materialization                      | Synthetic highly compressed worksheet      | Reject >8 MiB/entry or >32 MiB/workbook                 |
| P0 / code          | Sparse XLSX dimensional explosion  | Bound total rectangular allocation across sheets                                        | A1 + XFD1048576 and A1048576 cases         | Reject before any large array expansion                 |
| P0 / code          | XSS in generated HTML              | Sanitize Markdown and Mammoth DOCX HTML and attach restrictive CSP to exported artifact | Malicious Markdown / image / URL test      | No script/event handler/remote image                    |
| P0 / code          | EPUB CSS tracking                  | Remove arbitrary inline style from EPUB body                                            | Crafted remote url() styles                | No remote CSS URLs in output                            |
| P0 / code          | Abandoned PWA shares               | Limit file number/bytes, short TTL, cleanup on reuse                                    | Code tests and PWA E2E                     | Max 10 files and 50 MiB, expire after 15 minutes        |
| P0 / supply chain  | High/Critical advisories           | Update vulnerable packages; document remaining moderate findings                        | `npm audit --omit=dev --audit-level=high`  | 0 high/critical                                         |
| P0 / CI            | Mutable Actions / deployment token | Pin Actions commit SHA; least-privilege workflow; explicit deployment opt-in            | Workflow lint, GitHub Actions              | No uncontrolled deployment from fork                    |
| P0 / privacy       | Hidden outbound network traffic    | Browser canary capture with request inspection and CSP assertions                       | `security-egress-smoke.mjs`                | No observed remote request or canary egress             |
| P1 / deployment    | Depends on upstream FFmpeg CDN     | Copy verified FFmpeg ST/MT assets to user-owned Cloudflare R2 and restrict CORS         | SHA-256 + CORS + origin validation         | All executable assets under owned origins               |
| P1 / CSP           | Origin-level permissions           | Actual response-header verification, CSP reporting, regression tests                    | Chrome, Firefox, Safari on deployed domain | 0 unexpected script/worker/network sources              |
| P1 / availability  | PWA cache lifecycle                | Share expiry and isolation testing, stale cache migration, offline updates              | Playwright offline/share tests             | No sensitive leftovers or silently stale code           |
| P2 / resource      | Browser memory pressure            | Tests on 4GB devices, PDF/image decompression bounds and worker caps                    | Performance and fuzz campaigns             | No unrecoverable browser tab crash in acceptance corpus |
| P2 / parsing       | Parser vulnerabilities             | Differential fuzzing PDF/ZIP/HEIF/TIFF/XML, seeded corpus                               | Sanitizers, browser canary, timeouts       | Error surfaced, no unauthorized I/O                     |
| P2 / supply chain  | Transitive moderate advisories     | Replace or isolate Mammoth CLI dependencies; research maintained alternatives           | Audit and DOCX regression suites           | Zero unexplained runtime advisories                     |
| P2 / observability | False promise from NetworkBadge    | Rename metric and document its limited coverage                                         | Browser request inspection                 | No misleading proof of zero traffic                     |

## Validation matrix

### 1. Static build / dependency checks (required on every PR)

- `npm ci` using committed lockfile
- `npm run typecheck`; `npm run lint`; `npx prettier --check .`
- `npm run copy-wasm -- --check`
- `npm audit --omit=dev --audit-level=high` and separate review of moderate advisories
- Verify hashes of remote FFmpeg artifacts and pin all executable GitHub Actions by commit
- Evaluate changed transitive dependencies, install scripts, and bundle output

### 2. Regression & adversarial unit tests (required on every PR)

- XLSX normal sheets, sparse coordinates, ZIP highly compressed XML, numeric bounds, very large row/column extents.
- HTML output: script, event handler, `javascript:`, external `img`, SVG image data, local raster image data, CSP meta.
- EPUB: remove `style=url(https://...)` while preserving text.
- DOCX/PDF/CSV/image/media converters remain compatible; document changed formatting behavior.
- Unit tests must fail before each fix and pass after it in the test design process.

### 3. Browser E2E & network egress (required for production release)

- Run the real static bundle in Chrome with the same `_headers` as Cloudflare Pages.
- Select a file containing a unique sentinel, convert and download it, confirm output bytes.
- Record requests, URL query strings, request bodies, workers, CSP violations.
- Only approved same-origin static resources and pinned FFmpeg R2 assets may be requested.
- Fail on any unexpected remote origin, unexpected upload request, or sentinel in outgoing URLs/bodies.
- Repeat after real Cloudflare deployment, including redirect, service-worker active/absent, offline and cache-reset conditions.

### 4. Performance and denial-of-service (pre-production)

- Chrome/Firefox/Safari; desktops and resource-limited mobile browsers.
- 20 representative fixtures each for images/documents/data/media; measure browser RSS/heap/worker count.
- Synthetic ZIP bombs and sparse XLSX must reject quickly without allocating a huge matrix.
- Limit one video conversion at a time and expire idle workers; monitor cancellation and fallback.
- Positive acceptance: normal 5–20 MiB conversions complete, and memory returns towards baseline.
- No universal numeric browser RAM promise is possible without target-device benchmarks.

### 5. Deployment / rollback

- Deploy only from reviewed, protected `main`; default deployment disabled.
- Configure `ENABLE_CLOUDFLARE_DEPLOY=true` only after owned R2, CORS, FFmpeg hashes and Pages project are ready.
- Use minimally scoped Cloudflare API tokens; never reuse upstream Cloudflare credentials.
- Verify `Content-Security-Policy`, COOP/COEP, `X-Content-Type-Options`, Cache-Control and PWA update.
- Run live smoke against the deployed URL, record exact commit and asset digests.
- Roll back Cloudflare Pages to a known-good prior release on failed smoke; revoke CDN access on integrity violation.

## Current verification log (2026-10-13)

| Check                                | Result                | Evidence                                                                  |
| ------------------------------------ | --------------------- | ------------------------------------------------------------------------- |
| TypeScript / lint / Prettier         | PASS                  | Local `npm run typecheck`, `npm run lint`, `npx prettier --check .`       |
| Unit/integration tests, Node.js 20   | PASS                  | 875 passed, 1 skipped across 57 test files                                |
| Dependency audit                     | PASS with residuals   | 0 High/Critical; 3 Moderate via Mammoth > Argparse > Sprintf              |
| WASM package matching                | PASS                  | 23 committed WASM/OCR files match installed packages                      |
| Static production build              | PASS                  | 374 generated pages with CSP meta + header                                |
| Real Chrome format smoke             | PASS                  | 45/45 representative engine and format paths; actual output bytes checked |
| Real Chrome network-canary test      | PASS                  | No observed remote request and no canary egress for Markdown → HTML       |
| axe WCAG 2.1 AA (dark + light)       | PASS                  | 14/14 after light-muted contrast correction                               |
| Offline PWA/share target             | PASS                  | 15/15, including rejecting an 11-file share                               |
| Fork GitHub Actions                  | Pending latest commit | CI provides independently reproducible runner logs                        |
| Owner-controlled Cloudflare Pages/R2 | NOT STARTED           | Must be provisioned before production deployment                          |
| Safari/Firefox/fuzz campaigns        | NOT STARTED           | P1/P2 release qualification                                               |

Node.js 26 exposes a localStorage test-environment incompatibility in this project's
jsdom suite; the same suite passes in Node.js 20, which the upstream CI uses.

A passing test is **not** an independent penetration test; the production deployment
gate stays closed until a live Cloudflare instance, owned assets and a cross-browser
run have been verified.

## Residual risk to disclose

- A compromised website JavaScript bundle has access to files a user explicitly selects.
- WASM sandboxes cannot prevent every renderer/parser vulnerability or browser OOM.
- Service Worker traffic counters cannot prove no upload (some requests can bypass control).
- User-owned R2 and an audited build are important to avoid blindly trusting an upstream CDN.
- Any intentionally exported HTML/EPUB can be opened in another, differently secured viewer.
