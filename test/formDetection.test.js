import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyFormSignals, credentialFieldRole } from '../extension/src/formDetection.js'

test('classifies login, registration, password change, and multi-step forms', () => {
  assert.equal(classifyFormSignals({ fields: [{ type: 'email', autocomplete: 'username' }, { type: 'password', autocomplete: 'current-password' }] }).kind, 'login')
  assert.equal(classifyFormSignals({ text: 'Create account', fields: [{ type: 'email' }, { type: 'password', autocomplete: 'new-password' }, { type: 'password', autocomplete: 'new-password' }] }).kind, 'registration')
  assert.equal(classifyFormSignals({ text: 'Update password', fields: [{ type: 'password', autocomplete: 'current-password' }, { type: 'password', autocomplete: 'new-password' }] }).kind, 'password-change')
  assert.equal(classifyFormSignals({ fields: [{ type: 'email', autocomplete: 'username' }] }).kind, 'username-step')
  assert.equal(classifyFormSignals({ path: '/account/change-password', fields: [{ type: 'password' }, { type: 'password' }] }).kind, 'password-change')
})

test('ignores hidden and disabled credential fields', () => {
  const result = classifyFormSignals({ fields: [{ type: 'password', visible: false }, { type: 'email', visible: false }] })
  assert.equal(result.kind, 'unknown')
  assert.equal(result.passwordCount, 0)
})

test('understands autocomplete token lists and password fields temporarily shown as text', () => {
  assert.equal(credentialFieldRole({ type: 'text', autocomplete: 'section-checkout new-password', name: 'password' }), 'new-password')
  assert.equal(credentialFieldRole({ type: 'text', autocomplete: 'section-login username webauthn' }), 'username')
  assert.equal(credentialFieldRole({ type: 'text', name: 'confirmPassword' }), 'confirmation-password')
  assert.equal(credentialFieldRole({ type: 'password', label: 'Confirm your current password' }), 'current-password')
  assert.equal(credentialFieldRole({ type: 'text', autocomplete: 'one-time-code', name: 'code' }), 'one-time-code')
})

test('recognizes generic current/new pairs and text username steps without overreading OTP fields', () => {
  assert.equal(classifyFormSignals({
    fields: [{ type: 'password', label: 'Current password' }, { type: 'password', label: 'Password' }],
  }).kind, 'password-change')
  assert.equal(classifyFormSignals({
    fields: [{ type: 'text', name: 'accountIdentifier' }],
  }).kind, 'username-step')
  assert.equal(classifyFormSignals({
    fields: [{ type: 'text', autocomplete: 'one-time-code', name: 'otp' }],
  }).kind, 'unknown')
})

test('marks unlabeled password pairs as ambiguous instead of silently treating them as new-password fields', () => {
  const pair = classifyFormSignals({ fields: [{ type: 'password' }, { type: 'password' }] })
  assert.equal(pair.kind, 'login')
  assert.equal(pair.ambiguousPasswordCount, 2)
  assert.equal(classifyFormSignals({ text: 'Create account', fields: [{ type: 'password' }, { type: 'password' }] }).ambiguousPasswordCount, 0)
})
