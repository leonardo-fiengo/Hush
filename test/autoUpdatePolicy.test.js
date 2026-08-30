import test from 'node:test'
import assert from 'node:assert/strict'
import { automaticPasswordUpdateEligible, createAutomaticUpdateUndo, restoreAutomaticUpdate } from '../extension/src/autoUpdatePolicy.js'

const existing = {
  entry: { id: 'credential', username: 'person@example.com', password: 'old-secret', revision: 3, passwordHistory: [] },
  match: { matchType: 'exact', fillable: true, autoFillSafe: true, requiresConfirmation: false },
}

test('automatic updates require an enabled, unambiguous, exact safe login update', () => {
  const safe = {
    preferenceEnabled: true,
    kind: 'login',
    operation: 'update',
    existing,
    identifiedUnambiguously: true,
    ambiguousForm: false,
  }
  assert.equal(automaticPasswordUpdateEligible(safe), true)
  for (const unsafe of [
    { preferenceEnabled: false },
    { kind: 'password-change' },
    { operation: 'save' },
    { identifiedUnambiguously: false },
    { ambiguousForm: true },
    { existing: { ...existing, match: { ...existing.match, matchType: 'same-site', autoFillSafe: false } } },
    { existing: { ...existing, match: { ...existing.match, requiresConfirmation: true } } },
  ]) assert.equal(automaticPasswordUpdateEligible({ ...safe, ...unsafe }), false)
})

test('automatic update rollback is bound to the exact resulting password and revision', () => {
  const previous = { ...existing.entry, passwordChangedAt: 'before', encryptionVersion: 2 }
  const updated = { ...previous, password: 'new-secret', passwordChangedAt: 'after', revision: 4, passwordHistory: [{ password: 'old-secret' }] }
  const undo = createAutomaticUpdateUndo(previous, updated, { origin: 'https://example.com', hostname: 'example.com', createdAt: 42 })
  const restored = restoreAutomaticUpdate(updated, undo, 'undo-time')
  assert.equal(restored.password, 'old-secret')
  assert.equal(restored.passwordChangedAt, 'before')
  assert.deepEqual(restored.passwordHistory, [])
  assert.equal(restored.revision, 5)
  assert.equal(restored.updatedAt, 'undo-time')
  assert.throws(() => restoreAutomaticUpdate({ ...updated, password: 'edited-again' }, undo), /no longer be undone/iu)
  assert.throws(() => restoreAutomaticUpdate({ ...updated, revision: 5 }, undo), /no longer be undone/iu)
})
