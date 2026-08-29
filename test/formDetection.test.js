import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyFormSignals } from '../extension/src/formDetection.js'

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
