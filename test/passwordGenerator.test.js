import test from 'node:test'
import assert from 'node:assert/strict'
import { generatePassphrase, generatePassword } from '../src/lib/passwordGenerator.js'

test('generates a 20-character password with every selected group', () => {
  for (let index = 0; index < 100; index += 1) {
    const password = generatePassword()
    assert.equal(password.length, 20)
    assert.match(password, /[a-z]/u)
    assert.match(password, /[A-Z]/u)
    assert.match(password, /\d/u)
    assert.match(password, /[^a-zA-Z\d]/u)
    assert.doesNotMatch(password, /[Il1O0]/u)
  }
})

test('honors site-specific allowed and excluded characters', () => {
  const password = generatePassword({
    length: 40,
    uppercase: false,
    numbers: false,
    symbols: false,
    allowedCharacters: 'abcdef',
    excludedCharacters: 'ef',
  })
  assert.match(password, /^[abcd]{40}$/u)
  assert.throws(() => generatePassword({ allowedCharacters: '123', numbers: false }), /at least one character group/u)
})

test('generates a configurable multi-word passphrase with secure selections', () => {
  const passphrase = generatePassphrase({ words: 8, separator: '.', capitalize: true, includeNumber: true })
  const parts = passphrase.split('.')
  assert.equal(parts.length, 9)
  assert.match(parts.at(-1), /^\d{3}$/u)
  assert.equal(parts.slice(0, -1).some((word) => /^[A-Z]/u.test(word)), true)
})

test('generator output is not a repeated deterministic sequence', () => {
  const values = new Set(Array.from({ length: 256 }, () => generatePassword()))
  assert.equal(values.size, 256)
})

