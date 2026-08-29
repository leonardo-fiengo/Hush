import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('manifest globally activates Hush only on HTTPS and excludes the hosted bridge', async () => {
  const manifest = JSON.parse(await read('extension/manifest.json'))
  assert.deepEqual(manifest.host_permissions, ['https://*/*'])
  assert.equal(manifest.optional_host_permissions, undefined)
  assert.equal(manifest.host_permissions.some((pattern) => pattern.startsWith('http://')), false)
  assert.equal(manifest.content_scripts.length, 1)
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://*/*'])
  assert.deepEqual(manifest.content_scripts[0].exclude_matches, ['https://hush-password-manager.vercel.app/*'])
  assert.deepEqual(manifest.content_scripts[0].js, ['content.js'])
  assert.equal(manifest.content_scripts[0].all_frames, false)
})

test('old per-site permission and dynamic registration paths are absent', async () => {
  const source = (await Promise.all([
    'extension/src/popup.js',
    'extension/src/options.js',
    'extension/src/service-worker.js',
    'extension/src/messagePolicy.js',
  ].map(read))).join('\n')
  assert.doesNotMatch(source, /register-site|list-sites|remove-site|permissions\.request|registerContentScripts|executeScript/u)
})

test('content integration supports automatic focus suggestions and dynamic controlled forms once', async () => {
  const content = await read('extension/src/content.js')
  assert.match(content, /__hushContentLoaded/u)
  assert.match(content, /new MutationObserver/u)
  assert.match(content, /openPanel\(\{ automatic: true \}\)/u)
  assert.match(content, /Object\.getOwnPropertyDescriptor\(prototype, 'value'\)/u)
  assert.match(content, /new Event\('input', \{ bubbles: true, composed: true \}\)/u)
  assert.match(content, /new Event\('change', \{ bubbles: true, composed: true \}\)/u)
  assert.match(content, /popstate/u)
  assert.match(content, /lastPageUrl/u)
})

test('generation stays click-triggered and pending password changes commit only in save-pending', async () => {
  const [content, worker] = await Promise.all([read('extension/src/content.js'), read('extension/src/service-worker.js')])
  assert.match(content, /generate\.addEventListener\('click'/u)
  assert.doesNotMatch(content, /focus[^\n]*generateForContext/u)
  assert.match(worker, /if \(message\.action === 'generate-password'\) \{\s*await unlockedSession\(\)/u)

  const stageStart = worker.indexOf("if (message.action === 'stage-credential')")
  const saveStart = worker.indexOf("if (message.action === 'save-pending')")
  const stageBlock = worker.slice(stageStart, saveStart)
  const saveBlock = worker.slice(saveStart, worker.indexOf("throw new Error('Unknown content-script action.')"))
  assert.doesNotMatch(stageBlock, /replaceSessionEnvelope/u)
  assert.match(saveBlock, /replaceSessionEnvelope/u)
  assert.match(saveBlock, /passwordHistory/u)
})

test('fill suggestions are bound to a request id and exact live page URL', async () => {
  const [content, worker] = await Promise.all([read('extension/src/content.js'), read('extension/src/service-worker.js')])
  assert.match(content, /fillCredential\(credential\.id, response\.requestId, context\)/u)
  assert.match(content, /expectedPageUrl/u)
  assert.match(worker, /authorization\.pageUrl !== page\.href/u)
  assert.match(worker, /reported\.href !== current\.href/u)
  assert.match(worker, /current\.origin !== context\.url\.origin/u)
})

test('locked pages expose only the Hush control and no credential or generator secret', async () => {
  const [content, worker, popup] = await Promise.all([
    read('extension/src/content.js'),
    read('extension/src/service-worker.js'),
    read('extension/src/popup.js'),
  ])
  assert.match(content, /document\.documentElement\.append\(host\)/u)
  assert.match(popup, /Hush is locked\./u)
  assert.match(worker, /if \(message\.action === 'request-credentials'\) \{\s*const active = await unlockedSession\(\)/u)
  assert.match(worker, /if \(message\.action === 'generate-password'\) \{\s*await unlockedSession\(\)/u)
  const summaryBlock = worker.slice(worker.indexOf('function credentialSummary'), worker.indexOf('function matchesForPage'))
  assert.doesNotMatch(summaryBlock, /password/u)
})
