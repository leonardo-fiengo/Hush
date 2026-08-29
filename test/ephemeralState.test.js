import test from 'node:test'
import assert from 'node:assert/strict'
import { openEphemeralState, sealEphemeralState } from '../extension/src/ephemeralState.js'

async function key() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

test('encrypted temporary state survives serialization without exposing its secret', async () => {
  const dataKey = await key()
  const expiresAt = Date.now() + 60_000
  const record = await sealEphemeralState(dataKey, { tabId: 4, password: 'synthetic-new-password' }, { purpose: 'pending-credential', expiresAt })
  const serialized = JSON.stringify(record)
  assert.doesNotMatch(serialized, /synthetic-new-password/u)
  assert.deepEqual(await openEphemeralState(dataKey, JSON.parse(serialized), { purpose: 'pending-credential' }), { tabId: 4, password: 'synthetic-new-password' })
})

test('temporary state rejects expiry, tampering, and purpose swaps', async () => {
  const dataKey = await key()
  const expiresAt = Date.now() + 60_000
  const record = await sealEphemeralState(dataKey, { username: 'you@example.com' }, { purpose: 'multi-step-login', expiresAt })
  await assert.rejects(openEphemeralState(dataKey, record, { purpose: 'pending-credential' }), /expired|invalid/iu)
  await assert.rejects(openEphemeralState(dataKey, record, { purpose: 'multi-step-login', now: expiresAt }), /expired/iu)
  const tampered = { ...record, ciphertext: `${record.ciphertext.slice(0, -4)}AAAA` }
  await assert.rejects(openEphemeralState(dataKey, tampered, { purpose: 'multi-step-login' }), /invalid/iu)
})
