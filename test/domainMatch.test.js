import test from 'node:test'
import assert from 'node:assert/strict'
import { describePageUrl, matchCredentialToPage } from '../extension/src/domainMatch.js'

const paypal = { id: 'paypal', url: 'https://paypal.com', username: 'you' }

test('uses exact parsed hostnames instead of substring matching', () => {
  assert.equal(matchCredentialToPage(paypal, 'https://paypal.com/login').match, true)
  assert.equal(matchCredentialToPage(paypal, 'https://paypal.com.evil.test/login').match, false)
  assert.equal(matchCredentialToPage(paypal, 'https://paypal-login.com').match, false)
  assert.equal(matchCredentialToPage(paypal, 'https://www.paypal.com').match, false)
})

test('allows only explicit related hostnames and enforces ports', () => {
  const entry = { ...paypal, allowedHosts: ['accounts.paypal.com'] }
  assert.equal(matchCredentialToPage(entry, 'https://accounts.paypal.com/login').match, true)
  assert.equal(matchCredentialToPage(entry, 'https://other.paypal.com/login').match, false)
  assert.equal(matchCredentialToPage({ url: 'https://example.com:8443' }, 'https://example.com').match, false)
})

test('warns about HTTP and IDN pages and refuses silent filling', () => {
  const http = matchCredentialToPage({ url: 'http://example.com' }, 'http://example.com/login')
  assert.equal(http.match, true)
  assert.equal(http.fillable, false)
  assert.match(http.page.warnings.join(' '), /unencrypted HTTP/u)

  const idn = describePageUrl('https://xn--pple-43d.example')
  assert.equal(idn.isIdn, true)
  assert.match(idn.warnings.join(' '), /internationalized/u)
})

