# Release security checklist

Repository controls are implemented where code can enforce them. The account/store/audit items below require the owner or an independent reviewer and must be completed before a public trust claim.

## Repository and CI

- [x] Exact direct dependency versions and committed lockfile.
- [x] No remote runtime JavaScript.
- [x] Automated tests for crypto, imports, password intelligence, domain policy, message policy, and hostile-page signals.
- [x] Web and extension production builds in CI.
- [x] `npm audit` and generated CycloneDX SBOM in CI.
- [x] Dependabot configuration for npm and GitHub Actions; no auto-merge configuration.
- [x] CodeQL JavaScript analysis workflow.
- [x] CODEOWNERS review request for crypto, extension, and deployment-policy files.
- [ ] Owner: enable passkey/MFA on GitHub.
- [ ] Owner: protect `main`, disable force pushes/deletion, and require CI plus review.
- [ ] Owner: enable private vulnerability reporting, secret scanning, push protection, Dependabot alerts, and code scanning in repository settings.
- [ ] Owner: review and remove unnecessary GitHub Apps and deploy keys.
- [ ] Owner: rotate any credential found in Git history or logs immediately.

## Vercel

- [x] Repository includes HTTPS/HSTS, CSP, anti-framing, MIME, referrer, permission, and cross-origin headers in `vercel.json`.
- [x] Client code contains no server secret or vault API.
- [ ] Owner: protect Vercel with a passkey/MFA and review team access.
- [ ] Owner: protect production deployment and verify the production domain.
- [ ] Owner: separate preview/production environment variables and confirm no secret is exposed with a `VITE_` prefix.
- [ ] Owner: enable deployment notifications/log review and confirm logs never receive vault data.
- [ ] Owner: replace the extension's `externally_connectable` placeholder with the verified production Hush origin if it differs.

## Browser extension release

- [x] Manifest V3 and least-privilege optional per-site access.
- [x] No custom updater or downloaded executable code.
- [x] Extension CSP allows local code and the bundled Argon2 WebAssembly only.
- [x] Web CSP grants `wasm-unsafe-eval` for bundled Argon2id without granting general `unsafe-eval`.
- [x] Worker-resilient unlocked session uses trusted-context-only `chrome.storage.session`, contains no master password/plaintext payload, and is alarm-expired.
- [x] Packaged extension dashboard and autofill use the same authoritative encrypted vault.
- [x] Website bridge is limited to status, opening trusted extension pages, and encrypted migration staging.
- [x] Reproducible local command: `npm.cmd run build:extension`.
- [ ] Owner: publish only through official Chrome/Edge stores.
- [ ] Owner: protect publisher accounts and signing/release credentials with passkeys/MFA.
- [ ] Owner: review the exact `dist-extension` diff and permission warning before every upload.
- [ ] Owner: configure the final store extension ID as `VITE_HUSH_EXTENSION_ID` for the production web build.
- [ ] Owner: test update/rollback behavior from a signed prior store version.

## Verification and audit

- [ ] Run the real-site matrix in [EXTENSION_TEST_PLAN.md](EXTENSION_TEST_PLAN.md) with synthetic accounts.
- [ ] Test low-memory phones/laptops and document Argon2id unlock latency.
- [ ] Independent security engineer review: KDF, key wrapping, recovery, migration, key lifetime, sync, extension messages, URL policy, form handling, storage, backup, CSP, dependencies, and release delivery.
- [ ] Professional penetration test before recommending Hush as the sole store for users' credentials.
- [ ] Resolve all high/critical findings and document accepted residual risks.
