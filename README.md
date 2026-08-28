# Hush

Hush is a local-first password manager with a versioned authenticated vault, installable web UI, encrypted backups, direct encrypted device transfer, password intelligence, and a least-privilege Chromium extension.

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

## Web-vault features

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
- strict production security headers in `vercel.json`, local fonts/scripts only, and no analytics.

## Build and load the Chromium extension

Build one Manifest V3 package for Chrome or Edge:

```powershell
npm.cmd run build:extension
```

Then open the browser's extension-management page, enable developer mode, and load `dist-extension` as an unpacked extension.

The extension:

- owns an authenticated encrypted local envelope in `chrome.storage.local`;
- keeps the unlocked key and payload only in service-worker memory;
- locks on restart, service-worker suspension, browser/OS idle, or configured inactivity;
- asks for optional access one website at a time and requests no browsing-history permission;
- validates sender ID, sender URL/origin, top-frame ID, top-tab URL, and the live tab immediately before fill;
- performs exact hostname and port matching with URL parsing and Public Suffix List/IDN awareness;
- blocks HTTPS credentials on HTTP and refuses IDN filling by default;
- fills only after a user clicks Hush and returns only the selected credential to the approved page;
- detects normal, dynamic, React-style, login, registration, multi-step, and password-change fields, including open Shadow DOM;
- stages captures and password changes in memory, preserving the old password until the user confirms success;
- contains no remotely loaded code or custom updater.

The production web origin in `extension/manifest.json` must be verified before store publication. The final browser-store extension ID must also be configured before the web UI can use a direct encrypted management bridge. Until then, use an authenticated `.hush` handoff and keep only one actively edited authority.

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
