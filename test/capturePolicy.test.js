import test from 'node:test'
import assert from 'node:assert/strict'
import { credentialCaptureOperation, existingCredentialForCapture } from '../extension/src/capturePolicy.js'

const matches = [
  { entry: { id: 'personal', username: 'you@example.com', password: 'old-password' } },
  { entry: { id: 'work', username: 'you@work.example', password: 'work-password' } },
]

test('recognizes a newly entered password as an update to the saved username', () => {
  const existing = existingCredentialForCapture(matches, { kind: 'login', username: 'you@example.com' })
  assert.equal(existing?.entry.id, 'personal')
  assert.equal(credentialCaptureOperation(existing, 'different-password'), 'update')
  assert.equal(credentialCaptureOperation(existing, 'old-password'), 'unchanged')
})

test('uses an explicit multi-step selection and still saves password-only new logins', () => {
  assert.equal(existingCredentialForCapture(matches, { kind: 'login', credentialId: 'work' })?.entry.id, 'work')
  assert.equal(credentialCaptureOperation(null, 'new-password'), 'save')
})

test('password changes can identify the saved entry by its current password', () => {
  const existing = existingCredentialForCapture(matches, { kind: 'password-change', currentPassword: 'old-password' })
  assert.equal(existing?.entry.id, 'personal')
  assert.equal(credentialCaptureOperation(existing, 'replacement-password'), 'update')
  assert.equal(credentialCaptureOperation(null, 'replacement-password'), 'save')
})

test('does not overwrite an arbitrary duplicate username', () => {
  const duplicated = [...matches, { entry: { id: 'duplicate', username: 'you@example.com', password: 'another-password' } }]
  assert.equal(existingCredentialForCapture(duplicated, { kind: 'login', username: 'you@example.com' }), null)
})
