import test from 'node:test'
import assert from 'node:assert/strict'
import {
  countPasswords,
  PASSWORD_RISK_AGE_DAYS,
  PASSWORD_RISK_SCORE,
  passwordRisk,
} from '../src/lib/passwordRisk.js'

const now = Date.parse('2026-08-23T12:00:00.000Z')

test('flags passwords unchanged for 30 days or with a score below 70', () => {
  const entries = [
    { id: 'old', password: 'Long-Unique-Password-83!', passwordChangedAt: '2026-07-24T12:00:00.000Z', updatedAt: '2026-08-23T11:00:00.000Z' },
    { id: 'weak', password: 'short', passwordChangedAt: '2026-08-22T12:00:00.000Z' },
    { id: 'healthy', password: 'Fresh-Unique-Password-94!', passwordChangedAt: '2026-08-22T12:00:00.000Z' },
  ]
  const counts = countPasswords(entries)

  const oldRisk = passwordRisk(entries[0], counts, now)
  assert.equal(oldRisk.ageDays, PASSWORD_RISK_AGE_DAYS)
  assert.equal(oldRisk.stale, true)
  assert.equal(oldRisk.atRisk, true)

  const weakRisk = passwordRisk(entries[1], counts, now)
  assert.ok(weakRisk.health.value < PASSWORD_RISK_SCORE)
  assert.equal(weakRisk.lowStrength, true)
  assert.equal(weakRisk.atRisk, true)

  assert.equal(passwordRisk(entries[2], counts, now).atRisk, false)
})

test('treats a reused password as low-strength risk', () => {
  const entries = [
    { id: 'one', password: 'Same-Long-Password-94!', passwordChangedAt: '2026-08-22T12:00:00.000Z' },
    { id: 'two', password: 'Same-Long-Password-94!', passwordChangedAt: '2026-08-22T12:00:00.000Z' },
  ]
  const risk = passwordRisk(entries[0], countPasswords(entries), now)
  assert.equal(risk.health.label, 'Reused')
  assert.equal(risk.lowStrength, true)
})
