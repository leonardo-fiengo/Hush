import 'fake-indexeddb/auto'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createVault,
  deleteStoredVault,
  persistVault,
  readStoredVault,
  unlockVault,
} from '../src/lib/vaultCrypto.js'

test('creates, persists, and unlocks an authenticated encrypted vault', async () => {
  await deleteStoredVault()
  const secret = 'never-appears-in-the-envelope'
  const payload = {
    schemaVersion: 1,
    items: [{ id: 'one', name: 'Unicode café', password: secret }],
    preferences: { autoLockMinutes: 10 },
  }

  const created = await createVault('correct horse 🔐 phrase', payload)
  const stored = await readStoredVault()
  const ciphertextText = new TextDecoder().decode(new Uint8Array(stored.payload.ciphertext))

  assert.equal(stored.format, 'hush-vault-v1')
  assert.equal(ciphertextText.includes(secret), false)
  await assert.rejects(unlockVault('wrong password'), /Couldn’t unlock/)

  const opened = await unlockVault('correct horse 🔐 phrase')
  assert.equal(opened.payload.items[0].password, secret)
  assert.equal(opened.payload.items[0].name, 'Unicode café')

  const firstIv = [...created.envelope.payload.iv]
  const nextPayload = { ...payload, items: [...payload.items, { id: 'two', name: 'Second', password: 'another-secret' }] }
  const nextEnvelope = await persistVault(created.dataKey, created.envelope, nextPayload)
  assert.notDeepEqual([...nextEnvelope.payload.iv], firstIv)
  assert.equal(nextEnvelope.revision, 2)
  await assert.rejects(
    persistVault(created.dataKey, created.envelope, payload),
    /changed in another tab/,
  )

  const reopened = await unlockVault('correct horse 🔐 phrase')
  assert.equal(reopened.payload.items.length, 2)
  await deleteStoredVault()
})
