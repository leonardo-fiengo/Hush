import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compareEnvelopeVersions,
  decodePairingCode,
  deserializeEnvelope,
  encodePairingCode,
  sameVault,
  serializeEnvelope,
} from '../src/lib/vaultTransfer.js'

function envelope(revision = 3, changeId = 'change-b') {
  return {
    format: 'hush-vault-v1',
    revision,
    sync: { changeId, changedAt: '2026-08-26T12:00:00.000Z' },
    kdf: { name: 'PBKDF2', salt: new Uint8Array([1, 2, 3]) },
    wrappedKey: { algorithm: 'AES-GCM', iv: new Uint8Array([4, 5]), ciphertext: new Uint8Array([6, 7, 8]) },
    payload: { algorithm: 'AES-GCM', iv: new Uint8Array([9, 10]), ciphertext: new Uint8Array([11, 12, 13]) },
  }
}

test('round trips an encrypted vault envelope without exposing binary fields', () => {
  const original = envelope()
  const serialized = serializeEnvelope(original)
  const restored = deserializeEnvelope(serialized)

  assert.equal(serialized.includes('transferFormat'), true)
  assert.deepEqual([...restored.payload.ciphertext], [11, 12, 13])
  assert.deepEqual([...restored.wrappedKey.iv], [4, 5])
  assert.equal(sameVault(original, restored), true)
})

test('compares revisions and deterministically breaks concurrent revision ties', () => {
  assert.equal(compareEnvelopeVersions(envelope(4), envelope(3)), 1)
  assert.equal(compareEnvelopeVersions(envelope(3, 'b'), envelope(3, 'a')), 1)
  assert.equal(compareEnvelopeVersions(envelope(3, 'a'), envelope(3, 'a')), 0)
})

test('encodes typed offer and answer pairing codes', () => {
  const offer = { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:test\r\n' }
  const code = encodePairingCode('offer', offer)
  assert.equal(code.startsWith('HUSH1-'), true)
  assert.deepEqual(decodePairingCode(code, 'offer'), offer)
  assert.throws(() => decodePairingCode(code, 'answer'), /valid Hush answer/)
})
