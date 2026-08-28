import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { actionAllowed, classifyMessageSender } from '../extension/src/messagePolicy.js'
import { matchCredentialToPage } from '../extension/src/domainMatch.js'

const extensionId = 'abcdefghijklmnopabcdefghijklmnop'
const extensionOrigin = `chrome-extension://${extensionId}`

test('rejects spoofed, cross-frame, and unknown extension messages', () => {
  assert.equal(classifyMessageSender({ id: 'attacker', url: 'https://example.com', tab: { id: 1, url: 'https://example.com' }, frameId: 0 }, { extensionId, extensionOrigin }).kind, 'invalid')
  assert.equal(classifyMessageSender({ id: extensionId, url: 'https://example.com', origin: 'https://evil.test', tab: { id: 1, url: 'https://example.com' }, frameId: 0 }, { extensionId, extensionOrigin }).kind, 'invalid')
  assert.equal(classifyMessageSender({ id: extensionId, url: 'https://example.com/frame', origin: 'https://example.com', tab: { id: 1, url: 'https://example.com' }, frameId: 2 }, { extensionId, extensionOrigin }).kind, 'invalid')
  assert.equal(classifyMessageSender({ id: extensionId, url: 'https://example.com', origin: 'https://example.com', tab: { id: 1, url: 'https://evil.test' }, frameId: 0 }, { extensionId, extensionOrigin }).kind, 'invalid')
  assert.equal(classifyMessageSender({ id: extensionId, url: `${extensionOrigin}/popup.html`, frameId: 0 }, { extensionId, extensionOrigin }).kind, 'extension')
  assert.equal(actionAllowed('content', 'request-credentials'), true)
  assert.equal(actionAllowed('content', 'export-vault'), false)
  assert.equal(actionAllowed('content', 'getPassword'), false)
  assert.equal(actionAllowed('extension', 'unknown'), false)
})

test('blocks phishing, homograph, scheme, and port mismatches', () => {
  const entry = { url: 'https://paypal.com', username: 'you' }
  for (const url of ['https://paypal.com.evil.test', 'https://paypal-login.com', 'https://paypaI.com', 'http://paypal.com', 'https://paypal.com:8443']) {
    const match = matchCredentialToPage(entry, url)
    assert.equal(Boolean(match.fillable), false, url)
  }
  assert.equal(matchCredentialToPage(entry, 'https://paypal.com/login').fillable, true)
})

test('extension manifest has least-privilege defaults and a strict CSP', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'))
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'idle', 'scripting', 'storage'])
  assert.equal(manifest.permissions.includes('tabs'), false)
  assert.equal(manifest.permissions.includes('history'), false)
  assert.equal(manifest.host_permissions, undefined)
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*', 'http://*/*'])
  assert.deepEqual(manifest.externally_connectable.matches, ['https://hush-password-manager.vercel.app/*'])
  assert.match(manifest.content_security_policy.extension_pages, /object-src 'none'/u)
  assert.match(manifest.content_security_policy.extension_pages, /frame-ancestors 'none'/u)
})

test('production extension sources avoid remote code and DOM secret attributes', async () => {
  const files = await Promise.all(['content.js', 'service-worker.js', 'popup.js', 'options.js'].map((name) => readFile(new URL(`../extension/src/${name}`, import.meta.url), 'utf8')))
  const source = files.join('\n')
  assert.doesNotMatch(source, /\.innerHTML\s*=|\.outerHTML\s*=|\beval\s*\(|new\s+Function\s*\(/u)
  assert.doesNotMatch(source, /data-password|https?:\/\/[^'"`]*\.js/u)
  assert.doesNotMatch(source, /console\.(?:log|debug|info)/u)
})
