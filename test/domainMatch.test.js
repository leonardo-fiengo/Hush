import test from 'node:test'
import assert from 'node:assert/strict'
import { describePageUrl, matchCredentialToPage } from '../extension/src/domainMatch.js'

const paypal = { id: 'paypal', url: 'https://paypal.com', username: 'you' }

test('keeps exact HTTPS hostname and port matches strongest', () => {
  const result = matchCredentialToPage(paypal, 'https://paypal.com/login')
  assert.equal(result.match, true)
  assert.equal(result.fillable, true)
  assert.equal(result.matchType, 'exact')
  assert.equal(result.autoFillSafe, true)
  assert.equal(result.requiresConfirmation, false)
})

test('allows safe same-registrable-domain base and sibling hosts with confirmation', () => {
  for (const [saved, page] of [
    ['https://example.com', 'https://accounts.example.com/login'],
    ['https://www.example.com', 'https://login.example.com'],
    ['https://login.example.com', 'https://example.com'],
  ]) {
    const result = matchCredentialToPage({ url: saved }, page)
    assert.equal(result.match, true, `${saved} -> ${page}`)
    assert.equal(result.fillable, true, `${saved} -> ${page}`)
    assert.equal(result.matchType, 'same-site', `${saved} -> ${page}`)
    assert.equal(result.requiresConfirmation, true, `${saved} -> ${page}`)
    assert.equal(result.autoFillSafe, false, `${saved} -> ${page}`)
  }
})

test('rejects phishing suffixes, lookalikes, and unrelated private-suffix tenants', () => {
  for (const url of [
    'https://paypal.com.evil.com',
    'https://paypal-login.com',
    'https://paypaI.com',
  ]) assert.equal(matchCredentialToPage(paypal, url).match, false, url)

  assert.equal(matchCredentialToPage({ url: 'https://alice.github.io' }, 'https://bob.github.io').match, false)
})

test('keeps explicit host relationships manual and enforces unusual ports', () => {
  const entry = { ...paypal, allowedHosts: ['accounts.paypal.com'] }
  const explicit = matchCredentialToPage(entry, 'https://accounts.paypal.com/login')
  assert.equal(explicit.matchType, 'allowed-host')
  assert.equal(explicit.fillable, true)
  assert.equal(explicit.autoFillSafe, false)

  assert.equal(matchCredentialToPage({ url: 'https://example.com:8443' }, 'https://example.com').match, false)
  assert.equal(matchCredentialToPage({ url: 'https://example.com:8443' }, 'https://login.example.com:8443').match, false)
  const exactPort = matchCredentialToPage({ url: 'https://example.com:8443' }, 'https://example.com:8443/login')
  assert.equal(exactPort.fillable, true)
  assert.equal(exactPort.autoFillSafe, false)
  assert.equal(exactPort.requiresConfirmation, true)
})

test('blocks HTTP downgrade and keeps IDN and special-use matches manual or unavailable', () => {
  const downgrade = matchCredentialToPage({ url: 'https://example.com' }, 'http://example.com/login')
  assert.equal(downgrade.match, true)
  assert.equal(downgrade.fillable, false)
  assert.equal(downgrade.matchType, 'exact')
  assert.match(downgrade.page.warnings.join(' '), /unencrypted HTTP/u)

  const httpOnly = matchCredentialToPage({ url: 'http://example.com' }, 'http://example.com')
  assert.equal(httpOnly.fillable, false)
  assert.match(httpOnly.reason, /does not fill.*HTTP/u)

  const idn = describePageUrl('https://xn--pple-43d.example')
  assert.equal(idn.isIdn, true)
  assert.match(idn.warnings.join(' '), /internationalized/u)
  assert.equal(matchCredentialToPage({ url: idn.origin }, idn.origin).fillable, false)

  const local = matchCredentialToPage({ url: 'https://localhost' }, 'https://localhost/login')
  assert.equal(local.fillable, true)
  assert.equal(local.autoFillSafe, false)
  assert.equal(local.requiresConfirmation, true)
})
