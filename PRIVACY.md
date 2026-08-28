# Hush privacy policy

Effective date: 28 August 2026

Hush is a local-first password manager. This policy describes the application in this repository and must be reviewed again before a hosted public release.

## What Hush stores

The web app stores one authenticated encrypted vault envelope in the browser's IndexedDB. The Chromium extension stores one authenticated encrypted envelope in `chrome.storage.local`. The envelope contains ciphertext, salts, nonces, KDF settings, wrapped encryption keys, format/revision metadata, and authentication tags.

When unlocked, credential plaintext and a usable non-extractable vault key exist temporarily in browser or extension memory. Generated passwords and parsed imports also exist temporarily in memory. A recovery key is shown once and is not stored by Hush.

## Where data goes

The static Hush web host serves HTML, CSS, fonts, images, and JavaScript. It has no endpoint that receives vault plaintext, the master password, a raw vault key, generated passwords, or credential URLs.

Direct device linking transfers the encrypted envelope over a peer-to-peer WebRTC data channel. Cloudflare's public STUN service may receive network metadata needed to discover a peer connection; it does not receive vault plaintext. No TURN relay is configured.

The extension sends a selected username/password only to the exact approved top-level website after the user requests filling. It does not send the complete vault to a content script.

## Browser permissions

The extension uses:

- `storage` for the encrypted vault envelope;
- `idle` to lock usable keys when the device is idle or locked;
- `activeTab` and `scripting` to add Hush after the user enables the current site;
- optional per-site HTTP/HTTPS host access granted by the user.

It does not request browsing history and does not collect browsing history. Approved sites can be removed from the extension settings page.

## Telemetry and third parties

Hush includes no analytics, advertising, tracking pixels, crash-reporting SDK, remote runtime JavaScript, or marketing widgets in the vault. Hush does not currently collect telemetry.

If telemetry is added later, it must be opt-in, separated from vault operations, and must never include passwords, generated passwords, raw/wrapped keys, recovery keys, master passwords, credential URLs, or account inventories.

## Clipboard

Hush writes a value to the clipboard only after a user clicks Copy. It attempts to clear the same value after the configured timeout when browser permissions allow. Operating-system or third-party clipboard history may retain copied values.

## Retention and deletion

Encrypted data remains on a device until the user removes the local vault, clears browser/extension storage, or uninstalls the extension. Password history retention is configurable and can be deleted from the vault. Pending extension captures are memory-only, expire, and are discarded on lock or service-worker restart.

Hush has no account database, so there is currently no server-side account-deletion process. If accounts or synchronization are introduced, this policy must document retention, deletion, subprocessors, and data-subject request handling before launch.

## Backups

`.hush` backups are encrypted but remain sensitive. Anyone with a backup and its master password or recovery key can decrypt it. Users control where exported backups are stored and deleted.

## GDPR and contact

The current static application does not collect personal data into a Hush-controlled backend. A public operator must publish its legal identity and privacy contact before distribution. Where the operator processes personal data in the future, users will have applicable access, correction, erasure, restriction, portability, and objection rights under GDPR.

Security vulnerabilities must be reported privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

