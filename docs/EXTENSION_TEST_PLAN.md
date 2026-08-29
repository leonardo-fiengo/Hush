# Chromium extension security test plan

Automated unit tests cover exact host/port matching, suffix attacks, IDN and HTTP warnings, message sender/action policy, login/registration/change classification, hidden fields, nonce/integrity behavior, and static checks against remote code or DOM secret attributes. Hostile fixtures live in `test/fixtures/malicious-sites`.

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
- Browser/service-worker restart during a pending change: pending secret is discarded.
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

Release blockers: cross-domain fill, silent automatic fill, saving before success confirmation, overwriting a password after a failed change, complete-vault exposure to a content script or website, master-password entry on the hosted migration page, unexpected lock on ordinary worker suspension, session survival after explicit/device lock, or session material persisting to disk.
