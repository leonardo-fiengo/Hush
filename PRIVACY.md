# Hush privacy policy

Effective date: 29 August 2026

Hush is a local-first password manager. This policy describes the application in this repository and must be reviewed again before a hosted public release.

## What Hush stores

The standalone/migration web app may store one authenticated encrypted vault envelope in IndexedDB. When the Chromium extension is connected, it is authoritative and stores one authenticated encrypted envelope in `chrome.storage.local`; the website no longer presents the disconnected web manager. Envelopes contain ciphertext, salts, nonces, KDF settings, wrapped encryption keys, format/revision metadata, and authentication tags.

When the extension is unlocked, `chrome.storage.session` holds the random DEK's session material, vault identity/revision, and expiry metadata in memory. Short-lived generated/pending credentials, multi-step login context, and automatic-update Undo data are separately encrypted with that DEK before entering session storage. Session storage holds neither the master password nor plaintext vault. Undo data contains the previous credential secret and is purpose-bound to the originating tab and site, expires after ten minutes, and is removed on lock, browser restart, tab closure, or unrelated navigation. A worker temporarily imports the DEK as a non-extractable key and decrypts authenticated data for an operation. Generated passwords, credential plaintext, and parsed imports also exist temporarily in trusted extension memory. A recovery key is shown once and is not stored by Hush.

When a user explicitly asks to unlock from a website field, Hush may keep a two-minute trusted-session routing record so the extension-owned unlock window can return to that field. It contains a random request ID, tab/window identifiers, timestamp, and HTTPS origin/hostname. It contains no field value, credential, master password, or full page URL, is unavailable to content scripts, and is discarded after navigation, reload, tab closure, lock, completion, expiry, extension reload, or browser restart.

## Where data goes

The static Hush web host serves HTML, CSS, fonts, images, and JavaScript. It has no endpoint that receives vault plaintext, the master password, a raw vault key, generated passwords, or credential URLs. Its extension bridge can read status, open an extension-owned page, and stage an encrypted migration envelope; it cannot request decrypted extension data.

Direct device linking transfers the encrypted envelope over a peer-to-peer WebRTC data channel. Cloudflare's public STUN service may receive network metadata needed to discover a peer connection; it does not receive vault plaintext. No TURN relay is configured.

The extension sends one selected username/password only to a safely matched top-level HTTPS page after the user clicks an account, or for one exact host when the user has enabled automatic exact-match filling. Same-site subdomain matches are labeled and remain click-to-fill. It does not send the complete vault to a content script.

## Browser permissions

The extension uses:

- `storage` for the encrypted vault envelope and memory-only unlocked session;
- `alarms` for the configured Hush inactivity deadline;
- `idle` to lock usable keys when the device itself locks;
- persistent `https://*/*` host access so one declared top-frame content script can detect forms and present suggestions without per-site activation.

It does not request browsing history, does not collect browsing history, never injects on HTTP, and excludes the hosted Hush web origin from content-script injection.

## Telemetry and third parties

Hush includes no analytics, advertising, tracking pixels, crash-reporting SDK, remote runtime JavaScript, or marketing widgets in the vault. Hush does not currently collect telemetry.

If telemetry is added later, it must be opt-in, separated from vault operations, and must never include passwords, generated passwords, raw/wrapped keys, recovery keys, master passwords, credential URLs, or account inventories.

## Clipboard

Hush writes a value to the clipboard only after a user clicks Copy. It attempts to clear the same value after the configured timeout when browser permissions allow. Operating-system or third-party clipboard history may retain copied values.

## Retention and deletion

Encrypted data remains on a device until the user removes the local vault, clears browser/extension storage, or uninstalls the extension. Password history retention is configurable and can be deleted from the vault. The unlocked extension session is removed on explicit lock, configured inactivity, device lock, extension reload/update, or browser-profile restart. Pending captures and multi-step context have short authenticated expiries, survive ordinary service-worker sleep only as ciphertext, and are discarded on lock, tab closure, expiry, unrelated navigation, extension reload, or browser-profile restart. Unlock-routing metadata expires after two minutes and is cleared on any originating-tab navigation or reload.

Hush has no account database, so there is currently no server-side account-deletion process. If accounts or synchronization are introduced, this policy must document retention, deletion, subprocessors, and data-subject request handling before launch.

## Backups

`.hush` backups are encrypted but remain sensitive. Anyone with a backup and its master password or recovery key can decrypt it. Users control where exported backups are stored and deleted.

## GDPR and contact

The current static application does not collect personal data into a Hush-controlled backend. A public operator must publish its legal identity and privacy contact before distribution. Where the operator processes personal data in the future, users will have applicable access, correction, erasure, restriction, portability, and objection rights under GDPR.

Security vulnerabilities must be reported privately as described in [SECURITY.md](SECURITY.md), not in a public issue.
