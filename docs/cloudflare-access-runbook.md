# Cloudflare Access runbook — Convert-it

## Purpose and current coverage

Convert-it is a static, browser-only converter. **The authentication gateway is
Cloudflare Access**, not a password stored in JavaScript, Pages environment
variables, GitHub secrets or a container. No application session service is required.

The account now has two self-hosted Access applications:

| Application                                    | Protected hostnames                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| Convert-it - Owner Access (Pages and previews) | `convert-it-8wh.pages.dev`, `*.convert-it-8wh.pages.dev`                   |
| Convert-it - Owner Access (custom domain)      | `convert.highwall-lab.us.ci` (reserved for the future Pages custom domain) |

Both use the account's existing email one-time PIN identity provider, an
**Allow** policy matching exactly the Cloudflare account owner's email address,
and an 8-hour Access session. Unmatched identities are denied by default.

The Pages app protects the canonical URL, every immutable hash deployment
and every preview/branch alias, including historical Pages deployments.
The custom hostname policy was created **before** attaching that hostname to
the Pages project to avoid an unprotected public entry point.

The owned R2 endpoint `convert-assets.highwall-lab.us.ci` contains only
versioned, SHA-256 pinned public FFmpeg JavaScript/WASM artifacts. It does
**not** receive converted documents; CORS permits only named web origins.

## Verification

Run this command _without any Access session cookies or credentials_:

```bash
node scripts/access-gate-smoke.mjs
```

All covered URLs must redirect (HTTP 302) to
`https://<team>.cloudflareaccess.com/cdn-cgi/access/login/...`.
Any anonymous 200, unprotected redirect, 404 or network error fails this check.

The same check is run in GitHub CI to detect accidental removal of the edge
authentication gateway. Authentication itself (email OTP delivery, browser
SSO and correct account selection) must be confirmed by the owner through a
real login; do not store OTPs or session cookies in CI.

To validate a new immutable deployment, set
`ACCESS_DEPLOYMENT_URL=https://<hash>.convert-it-8wh.pages.dev`.
After the custom domain is attached, set
`ACCESS_CUSTOM_DOMAIN=https://convert.highwall-lab.us.ci`.

## Security trade-offs

- Cloudflare Access gates **network requests**. It does not revoke files
  already downloaded to an authenticated browser or purge installed PWA
  offline caches on logout. Avoid using shared browser profiles with
  confidential documents; clear the site data to erase offline caches.
- Email OTP provides ownership-based authentication, but it is not equivalent
  to phishing-resistant WebAuthn/FIDO2 MFA. Consider replacing OTP with the
  Cloudflare Account identity provider + account MFA if the site becomes
  sensitive or is shared with more people.
- Do not add broad email-domain selectors, Everyone, Bypass or service-token
  policies without independent review. Avoid `*.pages.dev` global rules:
  the wildcard must be scoped to Convert-it's own hostname only.
- Changing a Pages preview protection toggle may modify Access applications.
  Re-run the anonymous gate immediately after any Access/Pages/DNS changes.
- If the main custom hostname is activated, protect it via its separate
  Access application. Otherwise the Pages hostname will be safe while the
  custom domain might unintentionally remain public.

## Release controls

The owner should sign in successfully using email OTP, then verify real
conversions, offline/PWA expectations and logout behavior. Keep the static
site's previously established security and integrity gates. Require GitHub PR
checks for all source updates and avoid force pushes to production.
