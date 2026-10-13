# Browser security phase 3 — 2026-10-13

## Independent coverage

Tests target the deployed HTTPS staging site at
https://convert-it-8wh.pages.dev and record actual conversion downloads.

| Browser engine           | Core compatibility                   | Malicious input |
| ------------------------ | ------------------------------------ | --------------- |
| Chromium (Chrome)        | 45/45 full format pairs from phase 2 | 3/3             |
| Firefox 153 (Playwright) | 5/5                                  | 3/3             |
| WebKit 26.5 (Playwright) | 5/5                                  | 3/3             |

Core cases: Markdown → HTML, CSV → JSON, PNG → WebP, DOCX → HTML and WebM → MP4
through **explicitly forced pinned FFmpeg**. The same worker WASM endpoint and
SHA-256 checks are exercised by all engines. The malicious-input set covers
sparse XLSX, a compressed 9 MiB XML expansion and Markdown script/image
injection with external network egress monitoring.

These are desktop browser engines, **not a real physical iOS Safari or
low-memory Android device**. The full 45-format matrix has only been run on
Chrome, while Firefox/WebKit cover five representative format classes.

## Automated gates

`scripts/cross-browser-security-smoke.mjs [firefox|webkit|chromium]` asserts:

- Exact HTTPS build of the application, cross-origin isolation and output bytes.
- Owner-controlled FFmpeg WASM request for the forced FFmpeg test case.
- No unexpected remote request outside the application's Pages origin and the
  pinned owner-controlled R2 asset host.
- No CSP policy violations observed in the page.

`scripts/browser-adversarial-smoke.mjs [firefox|webkit|chromium]` asserts:

- Very sparse XLSX and highly compressible XLSX XML are rejected with an error
  in the UI, rather than materializing an oversized worksheet.
- The browser remains alive after rejecting the input.
- Markdown → HTML download strips embedded script and remote images, and no
  unexpected network request was observed in that test flow.

Both scripts run locally and against staging; the dedicated GitHub CI job
builds its own PR commit and runs Firefox + WebKit automatically.

## Advisory: Mammoth → argparse → sprintf-js

As of this test, `npm audit --omit=dev` reports three **Moderate** entries
in the same dependency chain, and zero High / Critical entries.

- `GHSA-hp3w-g68c-fv3c`: unbounded precision in `sprintf-js <=1.1.3`.
- `mammoth@1.13.0` declares `argparse ~1.0.3`; `argparse@1.0.10`
  declares `sprintf-js ~1.0.2`.
- The reference from Mammoth to `argparse` is found in the CLI entrypoint
  `node_modules/mammoth/bin/mammoth`, not under `mammoth/lib` or
  `mammoth/browser`.
- The emitted public JS chunks have no literal `argparse`, `sprintf-js`,
  or `ArgumentParser` references. This supports but does **not prove**
  lack of vulnerable execution paths in the browser.
- Convert-it does not invoke the Mammoth CLI or expose an API accepting
  sprintf formatting strings. The risk is therefore assessed as lower for
  this browser-only deployment than for an exposed CLI service.

**Status: risk acknowledged, not patched.** Continue blocking High/Critical,
document this transitive CLI-only exception, and replace or update the
dependency when a tested and maintained fix becomes available. Do not apply
an unsupported major-version npm override just to silence audit warnings.

## Outstanding release checks

- Test on an actual iOS Safari and Android low-memory device.
- Long-run memory measurement, cancellation/retry, and fuzz campaigns across
  PDF/ZIP/HEIF/TIFF/XML document parsers.
- Real security review of new commits, branch protection and deployment
  rollback rehearsal before formal production custom-domain assignment.
- Do not claim that a finite set of browser tests guarantees zero exfiltration.
