# Hush

A local-first password manager interface with a real encrypted storage path and a flexible CSV/TSV import studio.

## Run it

On Windows, double-click `Hush.cmd` in the project folder.

Or start it from PowerShell:

```powershell
npm.cmd install
npm.cmd run dev
```

Open the local address printed by Vite. `npm.cmd` is used because this Windows environment blocks PowerShell script shims.

## What works

- First-run sample vault and encrypted-vault creation
- AES-256-GCM vault encryption through Web Crypto
- PBKDF2-SHA-256 master-key derivation with 600,000 iterations
- A random per-vault data key wrapped by the master-password key
- Encrypted IndexedDB persistence with fresh IVs on each save and revision checks that reject stale-tab overwrites
- Lock/unlock, automatic inactivity lock, add/edit/delete, search, favorites/recent use, reveal, copy timer, generator, and encrypted archive download
- Local password-risk analysis that prioritizes length and guess resistance instead of rigid composition rules
- Vault-wide reuse detection, with reused passwords treated as high-priority risk even when they are long
- Pattern checks for common passwords, keyboard/sequential runs, repeated patterns, predictable password words, dates, and account/service context
- Password age is retained as useful metadata but is not treated as a reason to force routine password rotation
- Local CSV/TSV parsing with BOM, CRLF, quoted commas, escaped quotes, and multiline values
- Header/delimiter controls, A/B/C column mapping, required fields, masked password previews, duplicate handling, and review states
- One-based discontinuous ranges such as `1-10, 14-17, 19-29`, including validation and overlap deduplication
- Responsive navigation, mobile import layouts, focus styles, reduced-motion support, and keyboard search (`Ctrl/Cmd + K`)

## Password scoring

Hush does not treat uppercase/lowercase/number/symbol composition as proof that a password is strong. The local score uses length as the main positive signal and then lowers the score when the password is easier to guess because it contains recognizable patterns.

Current local signals include:

- password reuse inside the vault
- very common passwords
- keyboard and ascending/descending sequences
- repeated characters or repeated chunks
- generic password words such as `password`, `secret`, or `admin`
- years and recognizable dates
- service, username, email-local-part, or domain context

The score is intended as a practical local risk indicator, not as a claim of exact entropy or exact cracking time. A future production release can augment this with a reviewed guessability estimator and an optional privacy-preserving known-breach check.

## Security scope

The encrypted vault envelope is stored locally in IndexedDB. The master password is not stored. Imported source files and parsed values remain in memory and are cleared after completion.

The `.hush` download is an encrypted archive of the stored envelope. Restore tooling is not included in this prototype, so it is not presented as a recoverable backup.

This is a polished client-side implementation, not a security-audited production release. A real release should add a strict CSP, hardened packaging/update delivery, dependency review, large-file parsing in a worker, broader automated browser testing, and an independent cryptographic/security audit.

## Verify

```powershell
npm.cmd test
npm.cmd run build
```

The tests cover discontinuous ranges, overlap deduplication, malformed/out-of-range input, quoted and multiline CSV cells, BOM/CRLF handling, password-whitespace preservation, password-risk patterns/context/reuse, vault-health scoring, master-password quality checks, encrypted round trips, fresh IVs, wrong-password rejection, and stale-tab write conflicts.
