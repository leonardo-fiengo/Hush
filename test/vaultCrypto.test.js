import 'fake-indexeddb/auto'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  changeMasterPassword,
  createVault,
  deleteStoredVault,
  persistVault,
  readStoredVault,
  recoverVault,
  restoreVaultArchive,
  unlockVault,
  unlockVaultEnvelope,
} from '../src/lib/vaultCrypto.js'
import { createVaultEnvelope, importSessionDataKey, openVaultWithDataKey } from '../src/lib/vaultCryptoCore.js'
import { deserializeEnvelope, serializeEnvelope } from '../src/lib/vaultTransfer.js'

const encoder = new TextEncoder()

function cloneEnvelope(value) {
  return structuredClone(value)
}

test('an explicitly requested browser-session key can reopen an authenticated envelope', async () => {
  const created = await createVaultEnvelope('Session Granite Meadow Compass 74', { schemaVersion: 2, items: [{ id: 'session', password: 'kept' }] }, { includeSessionKeyMaterial: true })
  assert.equal(typeof created.sessionKeyMaterial, 'string')
  assert.equal(created.sessionKeyMaterial.length, 44)
  const restoredKey = await importSessionDataKey(created.sessionKeyMaterial)
  const payload = await openVaultWithDataKey(restoredKey, created.envelope)
  assert.equal(payload.items[0].password, 'kept')
})

async function createLegacyEnvelope(password, payload) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const passwordMaterial = await crypto.subtle.importKey('raw', encoder.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveKey'])
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' },
    passwordMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  const rawDataKey = crypto.getRandomValues(new Uint8Array(32))
  const dataKey = await crypto.subtle.importKey('raw', rawDataKey, 'AES-GCM', false, ['encrypt'])
  const wrapIv = crypto.getRandomValues(new Uint8Array(12))
  const payloadIv = crypto.getRandomValues(new Uint8Array(12))
  const wrappedCiphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: wrapIv, additionalData: encoder.encode('hush-vault-v1:wrapped-key'), tagLength: 128 },
    wrappingKey,
    rawDataKey,
  )
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: payloadIv, additionalData: encoder.encode('hush-vault-v1:payload'), tagLength: 128 },
    dataKey,
    encoder.encode(JSON.stringify(payload)),
  )
  rawDataKey.fill(0)
  return {
    format: 'hush-vault-v1',
    revision: 4,
    sync: { changeId: crypto.randomUUID(), changedAt: new Date().toISOString() },
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000, salt },
    wrappedKey: { algorithm: 'AES-GCM', iv: wrapIv, ciphertext: wrappedCiphertext },
    payload: { algorithm: 'AES-GCM', iv: payloadIv, ciphertext },
  }
}

test('creates, persists, and unlocks an Argon2id KEK/DEK vault', async () => {
  await deleteStoredVault()
  const secret = 'never-appears-in-the-envelope'
  const payload = {
    schemaVersion: 2,
    items: [{ id: 'one', name: 'Unicode café', password: secret }],
    preferences: { autoLockMinutes: 10 },
  }

  const created = await createVault('correct horse 🔐 phrase', payload)
  const stored = await readStoredVault()
  const serialized = serializeEnvelope(stored)

  assert.equal(stored.format, 'hush-vault-v2')
  assert.equal(stored.encryptionVersion, 2)
  assert.equal(stored.kdf.name, 'Argon2id')
  assert.equal(stored.kdf.memorySize >= 19 * 1024, true)
  assert.equal(stored.kdf.iterations >= 2, true)
  assert.equal(serialized.includes(secret), false)
  assert.equal(serialized.includes('correct horse'), false)
  assert.equal(created.dataKey.extractable, false)
  assert.match(created.recoveryKey, /^HUSH-(?:[A-Z2-9]{4}-){12}[A-Z2-9]{4}$/u)
  await assert.rejects(unlockVault('wrong password'), /Couldn’t unlock/)

  const opened = await unlockVault('correct horse 🔐 phrase')
  assert.equal(opened.payload.items[0].password, secret)
  assert.equal(opened.payload.items[0].name, 'Unicode café')

  const firstIv = [...created.envelope.payload.iv]
  const nextPayload = { ...payload, items: [...payload.items, { id: 'two', name: 'Second', password: 'another-secret' }] }
  const nextEnvelope = await persistVault(created.dataKey, created.envelope, nextPayload)
  assert.notDeepEqual([...nextEnvelope.payload.iv], firstIv)
  assert.equal(nextEnvelope.revision, 2)
  await assert.rejects(persistVault(created.dataKey, created.envelope, payload), /changed in another tab/)

  const reopened = await unlockVault('correct horse 🔐 phrase')
  assert.equal(reopened.payload.items.length, 2)
  await deleteStoredVault()
})

test('rejects modified ciphertext, nonce, and authenticated metadata', async () => {
  await deleteStoredVault()
  const password = 'Calm Granite Harbor Lantern 82'
  const created = await createVault(password, { schemaVersion: 2, items: [{ id: 'one', password: 'secret' }] })

  const ciphertext = cloneEnvelope(created.envelope)
  new Uint8Array(ciphertext.payload.ciphertext)[0] ^= 1
  await assert.rejects(unlockVaultEnvelope(password, ciphertext), /Couldn’t unlock/)

  const nonce = cloneEnvelope(created.envelope)
  nonce.payload.iv[0] ^= 1
  await assert.rejects(unlockVaultEnvelope(password, nonce), /Couldn’t unlock/)

  const metadata = cloneEnvelope(created.envelope)
  metadata.revision += 1
  await assert.rejects(unlockVaultEnvelope(password, metadata), /Couldn’t unlock/)
  await deleteStoredVault()
})

test('uses fresh salts and never repeats payload or metadata nonces', async () => {
  await deleteStoredVault()
  const first = await createVault('First Granite Harbor Lantern 82', { schemaVersion: 2, items: [] })
  const firstSalt = [...first.envelope.kdf.salt]
  await deleteStoredVault()
  const second = await createVault('Second Granite Harbor Lantern 82', { schemaVersion: 2, items: [] })
  assert.notDeepEqual([...second.envelope.kdf.salt], firstSalt)

  const seen = new Set()
  let envelope = second.envelope
  for (let index = 0; index < 64; index += 1) {
    const payloadIv = Buffer.from(envelope.payload.iv).toString('hex')
    const integrityIv = Buffer.from(envelope.integrity.iv).toString('hex')
    assert.equal(seen.has(payloadIv), false)
    assert.equal(seen.has(integrityIv), false)
    seen.add(payloadIv)
    seen.add(integrityIv)
    envelope = await persistVault(second.dataKey, envelope, { schemaVersion: 2, items: [{ id: String(index) }] })
  }
  await deleteStoredVault()
})

test('changes the master password by rewrapping the vault key', async () => {
  await deleteStoredVault()
  const created = await createVault('Old Granite Harbor Lantern 82', { schemaVersion: 2, items: [{ id: 'one', password: 'kept-secret' }] })
  const oldPayloadCiphertext = [...new Uint8Array(created.envelope.payload.ciphertext)]
  const changed = await changeMasterPassword('Old Granite Harbor Lantern 82', 'New Glacier Meadow Compass 47')

  assert.deepEqual([...new Uint8Array(changed.envelope.payload.ciphertext)], oldPayloadCiphertext)
  await assert.rejects(unlockVault('Old Granite Harbor Lantern 82'), /Couldn’t unlock/)
  const opened = await unlockVault('New Glacier Meadow Compass 47')
  assert.equal(opened.payload.items[0].password, 'kept-secret')
  await deleteStoredVault()
})

test('recovers a vault and immediately replaces its master-password wrap', async () => {
  await deleteStoredVault()
  const created = await createVault('Lost Granite Harbor Lantern 82', { schemaVersion: 2, items: [{ id: 'one', password: 'recover-me' }] })
  const recovered = await recoverVault(created.recoveryKey, 'Replacement Meadow Quartz Signal 56')
  assert.equal(recovered.payload.items[0].password, 'recover-me')
  await assert.rejects(unlockVault('Lost Granite Harbor Lantern 82'), /Couldn’t unlock/)
  assert.equal((await unlockVault('Replacement Meadow Quartz Signal 56')).payload.items[0].password, 'recover-me')
  await deleteStoredVault()
})

test('exports, restores, and authenticates an identical encrypted archive', async () => {
  await deleteStoredVault()
  await createVault('Archive Granite Harbor Lantern 82', { schemaVersion: 2, items: [{ id: 'one', password: 'archive-secret' }] })
  const original = await readStoredVault()
  const restoredEnvelope = deserializeEnvelope(serializeEnvelope(original, 2))
  await deleteStoredVault()
  await restoreVaultArchive(restoredEnvelope)
  assert.equal((await unlockVault('Archive Granite Harbor Lantern 82')).payload.items[0].password, 'archive-secret')
  await deleteStoredVault()
})

test('migrates a legacy PBKDF2 vault after a successful authenticated unlock', async () => {
  const legacy = await createLegacyEnvelope('Legacy Granite Harbor Lantern 82', {
    schemaVersion: 1,
    items: [{ id: 'legacy', password: 'preserved' }],
    preferences: { autoLockMinutes: 10 },
  })
  const opened = await unlockVaultEnvelope('Legacy Granite Harbor Lantern 82', legacy)
  assert.equal(opened.migrated, true)
  assert.equal(opened.envelope.format, 'hush-vault-v2')
  assert.equal(opened.envelope.kdf.name, 'Argon2id')
  assert.equal(opened.payload.items[0].password, 'preserved')
  await assert.rejects(unlockVaultEnvelope('wrong', legacy), /Couldn’t unlock/)
})
