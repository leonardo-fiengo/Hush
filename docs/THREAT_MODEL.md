# Hush threat model

Status: implemented baseline, 29 August 2026. This document describes the repository as it exists; it is not a claim of an independent audit.

## Security objective

Hush keeps credential plaintext and usable decryption keys on an unlocked client. Persistent storage, backups, device transfers, and any future server storage contain an authenticated encrypted vault envelope only.

Hush is designed to protect against:

- theft or read-only disclosure of the IndexedDB or extension storage database;
- compromise of the static Vercel deployment while the extension is authoritative, because the website bridge cannot request extension plaintext or unlock material;
- read access to cloud storage containing Hush backups;
- a malicious website requesting a credential saved for another hostname;
- common phishing hostnames, suffix tricks, ports, HTTP downgrade, and IDN/homograph risk;
- XSS in the web vault through React escaping, a script-restrictive CSP, no remote runtime scripts, and no use of `innerHTML`;
- forged, malformed, cross-frame, or unknown extension messages;
- excessive extension access by making website permissions optional and per-site;
- dependency and release-chain compromise through exact dependency versions, a lockfile, audits, CI, CodeQL, Dependabot review, no remotely executed JavaScript, and official browser-store distribution guidance;
- someone finding a device after it locks or after the browser profile restarts, because the memory-only extension session is cleared;
- accidental plaintext leakage through logs, persistent storage, analytics, backups, generated-password handling, or silent clipboard use;
- ciphertext, nonce, KDF-metadata, revision, or sync-metadata modification through AES-GCM authentication.

## Explicit limitation

If the user's operating system or browser is already fully compromised while Hush is unlocked, Hush cannot guarantee protection from malware reading memory, recording keystrokes, capturing the clipboard, observing filled form values, or modifying the browser or Hush code.

This also means Hush cannot make a hostile login page safe. It can prevent a credential for one hostname from being offered to another, but the approved page receives the credential after the user deliberately fills it.

## Assets

- credential usernames, passwords, notes, URLs, tags, and password history;
- the random 256-bit vault data-encryption key (DEK);
- the master password and Argon2id-derived key-encryption key (KEK);
- the recovery key;
- generated passwords before they are saved;
- the integrity and freshness metadata used for local/device synchronization;
- extension publisher, GitHub, and Vercel release authority.

## Trust boundaries

### Web vault

The standalone browser process and Hush's same-origin JavaScript are trusted while a fallback IndexedDB vault is unlocked. IndexedDB is untrusted persistent storage. A compromised static deployment could read a standalone web vault after the user unlocks it; CSP and release controls reduce this risk but cannot make hostile same-origin code safe.

When the extension is detected, the website becomes a status/open/migration surface and does not render an independently editable vault. It can stage ciphertext but cannot call privileged plaintext APIs. Master-password entry and full management occur on a packaged `chrome-extension://` page.

### Chromium extension

The service worker is privileged and owns vault operations. Popup/options/full-manager pages are trusted packaged extension pages. `chrome.storage.session` holds only DEK session material plus identity and expiry metadata and is restricted to trusted extension contexts. Content scripts and every web page are less trusted. A content script cannot choose the domain being searched, request the full vault, export a vault, or invoke privileged extension-page actions.

Only the top frame is supported. Cross-origin and nested frames are rejected rather than receiving credentials. The service worker derives the actual URL from the browser-provided sender, verifies sender ID, sender URL, sender origin, top-tab URL, and frame ID, then repeats the active-tab origin check immediately before filling.

### Device linking

WebRTC pairing codes contain connection metadata, not vault plaintext, passwords, or raw keys. A linked device receives the same authenticated encrypted envelope stored locally. The raw DEK and master password are never transmitted. Cloudflare STUN may observe network metadata but not the encrypted vault payload.

### Backup and recovery

A `.hush` file contains ciphertext, KDF parameters, salts, nonces, wrapped DEK copies, format/revision metadata, and authentication tags. Restore authenticates and decrypts the archive before replacing local state. The recovery key is displayed once and is never stored by Hush; possession of it plus the encrypted vault is equivalent to master-password recovery authority.

## Important controls

- Argon2id v1.3, currently 64 MiB, three passes, parallelism one, with a random 16-byte salt.
- Random 32-byte DEK generated with `crypto.getRandomValues()`.
- AES-256-GCM with a fresh random 96-bit nonce for every key wrap, payload encryption, recovery wrap, and metadata-authentication operation.
- Authenticated format version, vault ID, revision, sync metadata, KDF metadata, wrapped keys, payload descriptor, and recovery descriptor.
- Bounds on imported KDF parameters and archive sizes to limit denial-of-service inputs.
- The session DEK is kept only in Chromium's in-memory session storage; each temporary byte buffer is cleared after importing a non-extractable Web Crypto key.
- Lock on browser-profile restart, extension reload/update, manual request, configured Hush inactivity, device lock, or an elapsed sleep interval.
- Clipboard writes occur only after a user click and are cleared on a configurable best-effort timer. Clipboard history software may retain values.
- Credential updates are staged in extension memory and applied only after the user confirms that the website accepted the transaction.
- Previous passwords remain encrypted, have timestamps and bounded retention, and can be deleted manually.

## Residual risks

- Browser extensions are privileged software; a malicious signed update could access unlocked credentials.
- Closing the last browser window may not end the browser profile when background/startup features remain active; the configured inactivity deadline and device-lock event remain the reliable controls.
- Password strength and guessed-entropy values are conservative estimates, not exact cracking-time predictions.
- Clipboard clearing depends on browser permission and cannot erase third-party clipboard history.
- WebRTC metadata can reveal IP/network information to peers and the STUN service.
- A malicious or compromised approved website receives credentials the user chooses to fill.
- Argon2id parameters suitable for the benchmark machine may need adjustment on low-memory mobile devices.
- The code has automated tests but has not had an independent professional cryptographic review or penetration test.

## Release gate

Do not market Hush as security-audited or recommend making it the sole copy of irreplaceable credentials until the independent review in [RELEASE_SECURITY_CHECKLIST.md](RELEASE_SECURITY_CHECKLIST.md) is complete.
