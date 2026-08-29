import test from 'node:test'
import assert from 'node:assert/strict'
import { automaticMatch, normalizeFormRequest } from '../extension/src/autofillPolicy.js'

function candidate(id, overrides = {}) {
  return {
    entry: { id },
    match: { fillable: true, autoFillSafe: true, matchType: 'exact', ...overrides },
  }
}

test('automatic fill requires the encrypted single-exact preference and one safe match', () => {
  const exact = candidate('one')
  const form = { formKind: 'login', focusRole: 'password' }
  assert.equal(automaticMatch([exact], { autofillSingleExact: false }, form), null)
  assert.equal(automaticMatch([exact], { autofillSingleExact: true }, form)?.entry.id, 'one')
  assert.equal(automaticMatch([exact, candidate('two')], { autofillSingleExact: true }, form), null)
  assert.equal(automaticMatch([candidate('same', { matchType: 'same-site', autoFillSafe: false })], { autofillSingleExact: true }, form), null)
  assert.equal(automaticMatch([candidate('idn', { fillable: false, autoFillSafe: false })], { autofillSingleExact: true }, form), null)
})

test('registration and new-password fields never silently generate or fill', () => {
  const exact = candidate('one')
  const enabled = { autofillSingleExact: true }
  assert.equal(automaticMatch([exact], enabled, { formKind: 'registration', focusRole: 'new-password' }), null)
  assert.equal(automaticMatch([exact], enabled, { formKind: 'password-change', focusRole: 'new-password' }), null)
  assert.equal(automaticMatch([exact], enabled, { formKind: 'password-change', focusRole: 'current-password' })?.entry.id, 'one')
})

test('an explicit same-origin multi-step selection disambiguates a password step', () => {
  const matches = [candidate('personal'), candidate('work')]
  const selected = automaticMatch(matches, { autofillSingleExact: false }, { formKind: 'login', focusRole: 'password' }, {
    credentialId: 'work',
    explicitSelection: true,
  })
  assert.equal(selected?.entry.id, 'work')
  assert.equal(selected?.reason, 'multi-step-selection')
  assert.equal(automaticMatch(matches, {}, { formKind: 'login', focusRole: 'username' }, { credentialId: 'work', explicitSelection: true }), null)
})

test('invalid content-provided form labels fail closed', () => {
  assert.deepEqual(normalizeFormRequest({ formKind: 'evil', focusRole: 'secret' }), { formKind: 'unknown', focusRole: 'unknown' })
})
