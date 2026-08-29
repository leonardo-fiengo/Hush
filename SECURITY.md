# Hush security policy

## Supported versions

Until the first audited public release, only the latest commit on `main` is maintained. This repository is not yet independently security-audited and should not be described as audited.

## Security design

- Encryption: AES-256-GCM through Web Crypto, unique random nonces, 128-bit tags.
- Password KDF: Argon2id v1.3; parameters and unique salt stored per vault.
- Key hierarchy: master password derives a KEK that wraps a random 256-bit DEK.
- Recovery: a separate one-time random recovery key wraps the same DEK.
- Vault: authenticated, versioned, client-side encrypted envelope.
- Server: static assets only; no ability to decrypt a vault.
- Password generation: CSPRNG with rejection sampling; no `Math.random()`.
- Extension: Manifest V3, persistent HTTPS-only top-frame activation, live-tab and exact-page authorization, parsed exact/same-site matching, click-to-fill suggestions, and opt-in single exact-match autofill.

See [the threat model](docs/THREAT_MODEL.md) and [architecture](docs/ARCHITECTURE.md) for details and limitations.

## Report a vulnerability privately

Do not open a public GitHub issue for an exploitable vulnerability or include real credentials in any report.

Use the repository's **Security → Report a vulnerability** private reporting form (GitHub Security Advisories). Include affected versions, reproduction steps using test credentials, impact, and any suggested mitigation. If private vulnerability reporting is not enabled on the repository, contact the repository owner privately and ask for a secure reporting channel before sharing exploit details.

The project will acknowledge a report, reproduce it, coordinate a fix and disclosure window, and credit the reporter if requested. No bounty program is currently promised.

## Scope

High-priority areas include vault format/KDF/key lifecycle, backup/recovery, IndexedDB and extension storage, extension permissions/message validation/domain matching/autofill, CSP/XSS, device linking, import parsing, dependencies, and the build/release chain.

Testing must use synthetic credentials and domains. Do not test third-party sites without authorization.
