import test from 'node:test'
import assert from 'node:assert/strict'
import {
  countPasswords,
  masterPasswordHealth,
  PASSWORD_RISK_SCORE,
  passwordRisk,
  vaultHealthScore,
} from '../src/lib/passwordRisk.js'

const now = Date.parse('2026-08-23T12:00:00.000Z')

test('password age is informational and does not create a rotation risk', () => {
  const entry = {
    id: 'old',
    password: 'River-Cobalt-Museum-Orbit-83!',
    passwordChangedAt: '2024-01-01T12:00:00.000Z',
  }
  const risk = passwordRisk(entry, countPasswords([entry]), now)

  assert.ok(risk.ageDays > 30)
  assert.equal(risk.stale, false)
  assert.equal(risk.atRisk, false)
})

test('flags short and predictable passwords', () => {
  const entries = [
    { id: 'common', name: 'Example', username: 'person', password: 'Password123!' },
    { id: 'sequence', name: 'Example', username: 'person', password: 'qwerty-123456' },
    { id: 'healthy', name: 'Example', username: 'person', password: 'River-Cobalt-Museum-Orbit-83!' },
  ]
  const counts = countPasswords(entries)

  const common = passwordRisk(entries[0], counts, now)
  assert.ok(common.health.value < PASSWORD_RISK_SCORE)
  assert.equal(common.atRisk, true)

  const sequence = passwordRisk(entries[1], counts, now)
  assert.ok(sequence.health.flags.includes('sequence'))
  assert.equal(sequence.atRisk, true)

  assert.equal(passwordRisk(entries[2], counts, now).atRisk, false)
})

test('penalizes passwords that contain service or account context', () => {
  const entry = {
    id: 'context',
    name: 'Netflix',
    username: 'leonardo@example.com',
    url: 'https://netflix.com',
    password: 'NetflixLeonardo2026!',
  }
  const risk = passwordRisk(entry, countPasswords([entry]), now)

  assert.ok(risk.health.flags.includes('context'))
  assert.equal(risk.atRisk, true)
  assert.match(risk.reason, /account|service/i)
})

test('treats a reused password as a high-priority risk', () => {
  const entries = [
    { id: 'one', password: 'River-Cobalt-Museum-Orbit-83!' },
    { id: 'two', password: 'River-Cobalt-Museum-Orbit-83!' },
  ]
  const risk = passwordRisk(entries[0], countPasswords(entries), now)

  assert.equal(risk.health.label, 'Reused')
  assert.equal(risk.reused, true)
  assert.ok(risk.health.value <= 35)
  assert.equal(risk.atRisk, true)
})

test('vault health reflects actual password quality and has no artificial floor', () => {
  const bad = [
    { id: 'one', password: '123456' },
    { id: 'two', password: 'password' },
    { id: 'three', password: 'qwerty' },
  ]
  const good = [
    { id: 'one', password: 'River-Cobalt-Museum-Orbit-83!' },
    { id: 'two', password: 'Glass-Violet-Harbor-Comet-71?' },
    { id: 'three', password: 'Maple!Tundra7Signal-Copper-42' },
  ]

  assert.ok(vaultHealthScore(bad) < 30)
  assert.ok(vaultHealthScore(good) >= 80)
})

test('master password requires both length and a non-predictable score', () => {
  assert.equal(masterPasswordHealth('abcdefghij').acceptable, false)
  assert.equal(masterPasswordHealth('Password123456789!').acceptable, false)
  assert.equal(masterPasswordHealth('River-Cobalt-Museum-Orbit-83!').acceptable, true)
})
