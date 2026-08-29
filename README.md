# Hush

Hush is a local-first password manager with a versioned authenticated vault, an extension-owned full manager and autofill session, an installable migration/fallback web UI, encrypted backups, direct encrypted device transfer, and password intelligence.

This repository is an implemented security baseline, not an independently audited release. Read the [threat model](docs/THREAT_MODEL.md), [architecture](docs/ARCHITECTURE.md), and [release checklist](docs/RELEASE_SECURITY_CHECKLIST.md) before trusting it with real credentials.

## Run the web vault

On Windows, double-click `Hush.cmd`, or use:

```powershell
npm.cmd install
npm.cmd run dev
```

The production build is:

```powershell
npm.cmd run build
```

## Security architecture

New vaults use:

- a random 256-bit vault data-encryption key (DEK);
- Argon2id v1.3 with a unique salt, currently 64 MiB / three passes / parallelism one;
- a master-password-derived key-encryption key (KEK) that wraps only the DEK;
- AES-256-GCM through Web Crypto for wrapping, vault encryption, and metadata authentication;
- a fresh random 96-bit nonce for every AES-GCM operation;
- a one-time 256-bit recovery key with its own HKDF/AES-GCM DEK wrap;
- an authenticated v2 format containing KDF parameters, revision/sync data, wrapped keys, ciphertext, and integrity metadata;
- authenticated migration from the previous PBKDF2 v1 format.

Master-password changes rewrap the same DEK rather than re-encrypting every credential. The master password, raw DEK, generated passwords, and vault plaintext are never persisted or transmitted. Usable Web Crypto keys are non-extractable and references are discarded when Hush locks.

Run the machine-specific KDF benchmark with:

```powershell
npm.cmd run benchmark:kdf
```

## Web and migration features

- encrypted IndexedDB persistence with atomic revision checks;
- lock on browser restart, manual request, inactivity, or elapsed sleep interval;
- authenticated `.hush` backup export and restore with rollback-safe validation;
- one-time recovery-key display and offline master-password recovery;
- configurable best-effort clipboard clearing with clipboard-history warning;
- encrypted, timestamped, bounded password history with manual deletion;
- CSPRNG password/passphrase generator with configurable groups, length, ambiguous-character avoidance, and site restrictions;
- guessability-oriented local scoring for common passwords, words, names, sequences, repeats, dates, affixes, leetspeak, account context, and passphrases;
- local CSV/TSV parsing, flexible mapping/ranges, duplicate review, and atomic encrypted import;
- encrypted-envelope WebRTC transfer with identity and revision checks;
- PWA installation and offline app shell;
- strict production security headers in `vercel.json`, including the narrow `wasm-unsafe-eval` capability required by bundled Argon2id, local fonts/scripts only, and no analytics;
- a ciphertext-only bridge that can detect the configured extension, open its packaged manager, and stage an encrypted legacy web vault for authenticated import;
- no website API for master passwords, session keys, decrypted credentials, or full-vault reads from the extension.

## Build and load the Chromium extension

Build one Manifest V3 package for Chrome or Edge:

```powershell
npm.cmd run build:extension
```

Then open the browser's extension-management page, enable developer mode, and load `dist-extension` as an unpacked extension.

The extension:

- owns an authenticated encrypted local envelope in `chrome.storage.local`;
- provides the full Hush dashboard as the packaged `vault.html` extension page, backed by the same vault used for autofill;
- keeps only DEK session material and expiry metadata in in-memory `chrome.storage.session`, never the master password or plaintext vault;
- survives normal Manifest V3 service-worker suspension without prompting again;
- locks on manual request, configured Hush inactivity, device lock, extension reload/update, or browser-profile restart;
- receives persistent HTTPS host access at install, runs a static top-frame content script on normal HTTPS pages, excludes the hosted Hush origin, and requests no browsing-history permission;
- validates sender ID, sender URL/origin, top-frame ID, top-tab URL, a short-lived suggestion authorization, and the exact live tab URL immediately before fill;
- keeps exact hostname and port matches strongest and allows manual, labeled same-registrable-domain suggestions through `tldts` private-suffix/IDN-aware parsing;
- blocks HTTPS credentials on HTTP and refuses IDN filling by default;
- automatically presents matching accounts on focus, supports an opt-in single exact-match autofill setting, and never silently chooses among multiple or same-site accounts;
- detects normal, dynamic, React-style, login, registration, multi-step, and password-change fields, including open Shadow DOM;
- offers click-to-generate registration/change passwords, keeps short-lived multi-step and pending-save state DEK-encrypted in trusted browser-session storage, recognizes changed saved passwords, and preserves the old password until the user confirms success;
- contains no remotely loaded code or custom updater.

The production web origin in `extension/manifest.json` must be verified before store publication. Configure the final browser-store ID as `VITE_HUSH_EXTENSION_ID` in the production web build. The extension can also bootstrap migration by opening the website with its own ID. Until the published ID is configured, use an authenticated `.hush` handoff.

## Verification

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run build:extension
npm.cmd audit
```

The automated suite covers vault creation/unlock/persistence, wrong passwords, ciphertext/nonce/metadata tampering, fresh salts/nonces, rewrap, recovery, backup restore, legacy migration, password patterns/guess estimates, secure generation, imports, transfers, strict domains/ports/IDN/HTTP, extension sender/action policy, form classification, permissions, and static remote-code/DOM-secret checks.

Hostile fixtures and the manual real-site matrix are documented in [the extension test plan](docs/EXTENSION_TEST_PLAN.md). GitHub CI builds both products, runs tests/audit, generates a CycloneDX SBOM, and uploads short-lived build artifacts. CodeQL and Dependabot configurations are included.

## Privacy and disclosure

Hush has no vault backend, analytics, advertising, tracking pixel, or remote runtime JavaScript. See [PRIVACY.md](PRIVACY.md) for data handling and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

If the operating system or browser is fully compromised while Hush is unlocked, malware may read memory, keystrokes, clipboard content, or filled form values. Hush cannot defend against that environment.
