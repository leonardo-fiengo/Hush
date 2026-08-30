# Chromium extension security test plan

Automated tests cover manifest-wide HTTPS activation, removal of per-site registration, exact and same-registrable-domain matching, private-suffix and suffix attacks, IDN and HTTP warnings, conservative automatic-fill policy, message sender/action policy, exact-page fill authorization, login/registration/change classification, dynamic/controlled field integration, pending updates, nonce/integrity behavior, and static checks against remote code or DOM secret attributes. Hostile fixtures live in `test/fixtures/malicious-sites`.

## Hostile local scenarios

- `paypal.com.evil.test` and `paypal-login.test`: no PayPal credential offered.
- HTTP downgrade of a saved HTTPS login: visible warning and no fill.
- Punycode/IDN hostname: visible warning and no fill.
- Nested and cross-origin frames: no content-script credential API; top frame only.
- Hidden password fields: ignored.
- Dynamically inserted and replaced fields: detected after the debounced observer scan.
- Mutation spam: observer remains debounced and page stays responsive.
- Fake Hush UI: compare against the real extension toolbar state; never trust page-drawn branding.
- Spoofed/unknown messages and caller-supplied domains: rejected.
- Prototype manipulation: native setters are looked up only at fill time; verify failure is safe.
- Open Shadow DOM login: detected; closed third-party Shadow DOM is intentionally unsupported.
- Registration failure: pending password is not saved.
- Password-change failure: old saved password remains current.
- Ordinary service-worker restart during a pending change: the DEK-encrypted session record resumes; lock, expiry, extension reload, browser restart, or tab closure discards it.
- Multiple matching accounts: suggestions list all accounts and no account is silently selected.
- Single exact match: optional automatic fill works only when enabled; same-site, IDN, special-use, registration, and new-password fields remain manual.
- Multi-step login: selected account or entered username carries to the same-origin password step and clears on unrelated navigation, timeout, lock, completion, and restart.
- SPA navigation or duplicate script execution: one Hush host remains and stale suggestion authorizations cannot fill the new page.
- Existing-login capture: submitting a different password for a known username prompts Update; submitting the unchanged saved password creates no redundant prompt.
- Generated-password durability: generation atomically creates only an encrypted, unsubmitted session candidate; worker sleep preserves it, abandonment never produces a save prompt, and submission promotes it before success detection.
- Field semantics: autocomplete token lists, text-revealed passwords, form-associated controls, Enter/custom-button submissions, and unlabeled matching confirmation pairs are recognized; OTP fields and mismatched confirmations are not captured.
- Password-only update: one exact fillable saved login may be updated without a username; same-site, blocked, or multiple candidates never select an arbitrary entry.
- Automatic changed-password update: with the opt-in disabled, the normal Update prompt remains; with it enabled, only a uniquely identified, exact HTTPS login plus explicit success evidence commits automatically.
- Automatic-update rollback: the previous secret is DEK-encrypted in session storage, scoped to the same tab/origin, expires after ten minutes, survives ordinary worker sleep, and refuses to overwrite any later credential revision.
- Duplicate success probes: concurrent page-ready signals serialize per tab and change the vault at most once.
- Suggestion dismissal: outside pointer/click and Escape close the surface without changing the page or vault.
- Locked-field handoff: focus shows only the small control; an explicit click opens packaged extension UI, successful unlock resumes the same connected field, and the website never receives the master password.
- Handoff invalidation: different request ID, tab, window, origin, exact page URL, disconnected field, navigation/reload, tab closure, or two-minute expiry refuses resumption and clears routing state.
- Never auto-lock: both settings surfaces show a prominent warning and require explicit confirmation before disabling inactivity locking.
- Service-worker suspension after unlock: the vault remains unlocked and the next user action succeeds without another password prompt.
- Configured inactivity expiry: the alarm removes the session even if no extension page is open.
- Device lock: the unlocked session is removed immediately; ordinary `idle` state alone does not override the configured timeout.
- Extension reload/update and browser-profile restart: the session is gone and Hush requires the master password again.
- Web migration: only an encrypted envelope reaches the extension; the master password is entered on an extension-owned page; an existing extension vault is never overwritten by the website.
- Device-link QR scanning: verify the browser's native `BarcodeDetector` path; if unavailable, Hush must fail safely and retain text-code pairing rather than relaxing extension CSP for blob workers.

## Real-site matrix

Use synthetic accounts and record browser/version, form type, result, and screenshots without secrets. Never automate against a bank or government service without permission.

| Category | Targets | Login | Multi-step | Registration/generator | Change/update |
| --- | --- | --- | --- | --- | --- |
| Identity | Google, Microsoft | [ ] | [ ] | [ ] | [ ] |
| Development | GitHub, GitLab | [ ] | [ ] | [ ] | [ ] |
| Retail | Amazon, one regional retailer | [ ] | [ ] | [ ] | [ ] |
| Community | Reddit, Discord | [ ] | [ ] | [ ] | [ ] |
| Social | Facebook, Instagram | [ ] | [ ] | [ ] | [ ] |
| Media | Netflix, Spotify | [ ] | [ ] | [ ] | [ ] |
| Finance sandbox | Stripe test mode | [ ] | [ ] | [ ] | [ ] |
| Banking | Owner-authorized test bank only | [ ] | [ ] | n/a | [ ] |
| Ecommerce | Shopify test store | [ ] | [ ] | [ ] | [ ] |
| Forum | Discourse test instance | [ ] | [ ] | [ ] | [ ] |
| Government | Authorized public test service only | [ ] | [ ] | n/a | [ ] |
| Framework | React, Vue, Angular local fixtures | [ ] | [ ] | [ ] | [ ] |
| Traditional | Server-rendered local fixture | [ ] | n/a | [ ] | [ ] |

Release blockers: cross-domain fill, ambiguous/same-site/registration automatic fill, filling after the authorized page URL changes, resuming an unlock on a different or navigated field, saving before success confirmation, overwriting a password after a failed change, complete-vault exposure to a content script or website, master-password entry on any website surface, unexpected lock on ordinary worker suspension, session survival after explicit/device lock, or session material persisting to disk.
