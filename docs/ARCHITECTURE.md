# Hush security architecture

## Vault authority

The Chromium extension is the authority when it is installed and connected. `chrome.storage.local` contains its authenticated encrypted envelope, the service worker enforces vault operations, and the packaged `vault.html` page provides the full manager using that same vault. Autofill and the dashboard therefore cannot diverge.

The web/PWA remains a standalone fallback and an explicit migration source for existing IndexedDB vaults. When the configured extension answers, the website stops presenting its independent manager. Its narrow external bridge can request status, open extension-owned pages, or stage an encrypted envelope. It cannot unlock the extension or request plaintext, a master password, session key material, credential lists, or individual secrets.

Until a published extension ID is configured for the production web build, the safe handoff is an authenticated `.hush` export/import. Set `VITE_HUSH_EXTENSION_ID` after publication; the extension's migration link can also bootstrap its ID into that browser.

## Key hierarchy

```text
master password
      |
      v
Argon2id (unique salt + stored parameters)
      |
      v
256-bit KEK --AES-256-GCM--> wrapped random 256-bit DEK
                                      |
                     +----------------+----------------+
                     |                                 |
                     v                                 v
              encrypted vault                  metadata auth tag
```

The master password is normalized with NFKC immediately before key derivation and is never stored or transmitted. Argon2id output is imported as a non-extractable AES-GCM KEK and its temporary byte buffer is overwritten. The DEK is random and independent of the master password.

Changing the master password authenticates the existing vault, derives a new KEK with a new salt, and wraps the same DEK. The vault payload ciphertext does not change.

## Recovery

New v2 vaults receive a random 256-bit recovery key. HKDF-SHA-256 derives a recovery wrapping key from it and a unique salt; that key wraps the same DEK with AES-256-GCM. The printable recovery key is shown once and not persisted.

Recovery authenticates the envelope and payload, derives a new Argon2id KEK from a replacement master password, and immediately replaces the old master-password wrap.

Legacy PBKDF2 v1 vaults migrate only after a successful authenticated unlock. They retain no recovery wrap until a future explicit recovery-key rotation flow is completed.

## Envelope v2

The serialized encrypted envelope contains:

- `format`, `encryptionVersion`, `vaultId`, `revision`, and sync metadata;
- the Argon2id algorithm, version, memory, passes, parallelism, hash length, and salt;
- the AES-GCM master-password-wrapped DEK;
- the optional HKDF/AES-GCM recovery-key-wrapped DEK;
- the AES-GCM encrypted payload and its schema version;
- a separate AES-GCM tag authenticating all envelope metadata.

Binary fields are base64 only at transfer/export boundaries. Persistent plaintext passwords, raw DEKs, and master passwords are not part of this format.

## Encryption and integrity

Every AES-GCM operation uses a fresh 12-byte CSPRNG nonce and a 128-bit authentication tag. Additional authenticated data binds each operation to its purpose, format, vault ID, schema, and relevant KDF metadata. The separate metadata record authenticates revisions, sync identifiers, descriptors, and wrapped-key data without forcing payload re-encryption during a master-password change.

## Persistence and rollback handling

The fallback web vault uses one atomic IndexedDB object-store transaction and compare-and-swap revision checks. The authoritative extension writes a complete serialized encrypted envelope through `chrome.storage.local`. Failed authentication or migration occurs before replacement. Records inside the encrypted payload have IDs, revisions, creation/update/password-change timestamps, and an encryption version.

Multi-device envelopes use revision ordering and deterministic change IDs for concurrent ties. This detects local stale writes and corruption; a future hostile cloud server additionally needs a device-authenticated monotonic log to prevent replay of an older, otherwise valid envelope.

## Extension flow

After authentication, Hush places only the random DEK's base64 session material, vault identity/revision, and activity timestamps in `chrome.storage.session`. Chromium keeps this area in memory, does not expose it to content scripts under Hush's access policy, and clears it on extension reload/update or browser-profile restart. A recreated service worker imports the bytes into a non-extractable Web Crypto key, authenticates and decrypts the current envelope, then overwrites the temporary byte buffer. The master password and plaintext payload are not stored in session storage.

Configured inactivity is enforced both on privileged operations and with `chrome.alarms`. User activity slides the deadline. Device lock clears the session immediately; normal worker suspension does not. Pending website captures deliberately remain worker-memory-only, so a worker restart discards an unconfirmed password update safely.

```text
permitted HTTPS top-level page
      |
content script: form signals + focus/click intent
      |
allow-listed message with no caller-supplied domain
      |
service worker derives and validates sender/tab/origin/frame
      |
exact or labeled same-site PSL/IDN/scheme/port policy
      |
short-lived exact-page authorization + selected fill
```

The manifest receives persistent `https://*/*` host access once at install so login suggestions work without per-site activation. It declares one top-frame content script, excludes the hosted Hush bridge origin, does not run on HTTP, and requests no browsing-history permission. Content scripts receive neither the complete vault nor a caller-directed domain search API. Passwords are never placed in data attributes or hidden helper nodes.

Focus automatically requests safe summaries. Manual fill remains available for exact and labeled same-registrable-domain matches. Optional automatic fill is encrypted in vault preferences and is limited to one exact, HTTPS, non-IDN, non-special-use match; registration, new-password, same-site, and ambiguous matches are never silently filled. The worker binds each suggestion response to a short-lived request ID and exact tab URL, then revalidates both before releasing only the selected credential.

Registration and password-change values remain pending in service-worker memory. Generated passwords require a click, and the old credential remains untouched until a same-origin page asks the user to confirm success. Multi-step login state stores only a short-lived username or credential ID in worker memory and is cleared on timeout, unrelated navigation, lock, restart, or completion. Service-worker restart safely discards all unconfirmed operations.

## Password intelligence

The estimator uses length-derived search space and conservative caps/penalties for common passwords, dictionary words, names, keyboard/alphabetic/numeric sequences, repeats, repeated words, dates/years, affixes, leetspeak, common capitalization, account context, and word-number patterns. Multi-word passphrases are recognized separately. It reports estimated guesses/entropy and Weak, Fair, Strong, or Excellent; it does not treat character-class composition as proof of strength.

The generator uses rejection sampling over `crypto.getRandomValues()` to avoid modulo bias, guarantees selected character groups, supports 12–64 character UI generation (8–256 in the library), ambiguous-character avoidance, site allow/exclude rules, and an eight-word passphrase default.

## Parameter benchmark

Run `npm.cmd run benchmark:kdf` on each target hardware class. The 28 August 2026 Windows x64 benchmark selected 64 MiB, three passes, parallelism one at approximately 324 ms in Node 24; see [KDF_BENCHMARK.md](KDF_BENCHMARK.md). Parameters are stored per vault so they can evolve without ambiguity.
