import test from 'node:test'
import assert from 'node:assert/strict'
import { credentialCaptureFromFields, credentialIdentityFromFields, inferredCaptureKind } from '../extension/src/captureDetection.js'

const field = (value, properties = {}) => ({ type: 'text', value, visible: true, ...properties })

test('captures generic registration password and matching confirmation in the right order', () => {
  const capture = credentialCaptureFromFields({
    kind: 'registration',
    fields: [
      field('person@example.com', { autocomplete: 'section-signup email' }),
      field('new-secret', { type: 'password', name: 'password' }),
      field('new-secret', { type: 'password', name: 'confirmPassword' }),
    ],
  })
  assert.deepEqual(capture, {
    ok: true,
    kind: 'registration',
    username: 'person@example.com',
    password: 'new-secret',
    currentPassword: '',
  })
})

test('refuses to stage a mismatched confirmation password', () => {
  assert.deepEqual(credentialCaptureFromFields({
    kind: 'registration',
    fields: [field('first', { type: 'password' }), field('different', { type: 'password', name: 'password_confirmation' })],
  }), { ok: false, reason: 'password-mismatch' })
})

test('recognizes unlabeled three-field password changes by position', () => {
  const capture = credentialCaptureFromFields({
    kind: 'password-change',
    fields: [field('old-secret', { type: 'password' }), field('new-secret', { type: 'password' }), field('new-secret', { type: 'password' })],
  })
  assert.equal(capture.currentPassword, 'old-secret')
  assert.equal(capture.password, 'new-secret')
})

test('recognizes a shown-as-text password and ignores one-time codes', () => {
  const capture = credentialCaptureFromFields({
    kind: 'login',
    fields: [
      field('person@example.com', { name: 'username' }),
      field('visible-secret', { name: 'password' }),
      field('123456', { autocomplete: 'one-time-code', name: 'otp' }),
    ],
  })
  assert.equal(capture.password, 'visible-secret')
  assert.equal(capture.username, 'person@example.com')
})

test('extracts the account and current password before generating a replacement', () => {
  assert.deepEqual(credentialIdentityFromFields([
    field('person@example.com', { autocomplete: 'username' }),
    field('old-secret', { type: 'password', autocomplete: 'section-security current-password' }),
  ]), { username: 'person@example.com', currentPassword: 'old-secret' })
})

test('promotes only high-confidence unlabeled password pairs at submission time', () => {
  const ambiguousPair = { kind: 'login', ambiguousPasswordCount: 2 }
  assert.equal(inferredCaptureKind([
    field('same-secret', { type: 'password' }),
    field('same-secret', { type: 'password' }),
  ], ambiguousPair), 'registration')
  assert.equal(inferredCaptureKind([
    field('password', { type: 'password' }),
    field('1234', { type: 'password' }),
  ], ambiguousPair), 'login')
  assert.equal(inferredCaptureKind([
    field('old-secret', { type: 'password' }),
    field('new-secret', { type: 'password' }),
    field('new-secret', { type: 'password' }),
  ], { kind: 'login', ambiguousPasswordCount: 3 }), 'password-change')
})
