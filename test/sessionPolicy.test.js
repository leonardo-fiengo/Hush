import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createSessionRecord,
  normalizeAutoLockMinutes,
  sessionExpired,
  sessionRecordIsValid,
  touchSessionRecord,
} from '../extension/src/sessionPolicy.js'

const SESSION_KEY = 'A'.repeat(43) + '='
const VAULT_ID = 'vault-identity-1234567890'

test('session records use the configured inactivity timeout', () => {
  const record = createSessionRecord({ vaultId: VAULT_ID, envelopeRevision: 4, sessionKeyMaterial: SESSION_KEY, autoLockMinutes: 15, now: 1_000 })
  assert.equal(record.expiresAt, 901_000)
  assert.equal(sessionExpired(record, 900_999), false)
  assert.equal(sessionExpired(record, 901_000), true)
})

test('touching a session slides its expiration without changing key material', () => {
  const record = createSessionRecord({ vaultId: VAULT_ID, envelopeRevision: 4, sessionKeyMaterial: SESSION_KEY, autoLockMinutes: 5, now: 1_000 })
  const touched = touchSessionRecord(record, 30, 60_000)
  assert.equal(touched.expiresAt, 1_860_000)
  assert.equal(touched.sessionKeyMaterial, SESSION_KEY)
  assert.equal(touched.envelopeRevision, 4)
})

test('Never disables inactivity expiry while preserving explicit lock controls', () => {
  const record = createSessionRecord({ vaultId: VAULT_ID, envelopeRevision: 1, sessionKeyMaterial: SESSION_KEY, autoLockMinutes: 0, now: 1_000 })
  assert.equal(record.expiresAt, null)
  assert.equal(sessionExpired(record, Number.MAX_SAFE_INTEGER), false)
})

test('invalid settings and malformed records fail closed', () => {
  assert.equal(normalizeAutoLockMinutes(1), 15)
  assert.equal(sessionRecordIsValid({}), false)
  assert.equal(sessionExpired({}, 1_000), true)
})
