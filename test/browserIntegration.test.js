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

test('generation stays click-triggered and password changes commit only through guarded capture flows', async () => {
  const [content, worker] = await Promise.all([read('extension/src/content.js'), read('extension/src/service-worker.js')])
  assert.match(content, /generate\.addEventListener\('click'/u)
  assert.doesNotMatch(content, /focus[^\n]*generateForContext/u)
  const generateStart = worker.indexOf("if (message.action === 'generate-password')")
  const generateBlock = worker.slice(generateStart, worker.indexOf("if (message.action === 'stage-login-step')"))
  assert.match(generateBlock, /const active = await unlockedSession\(\)/u)
  assert.match(generateBlock, /status: 'generated'/u)
  assert.match(generateBlock, /storePendingCapture/u)
  assert.doesNotMatch(generateBlock, /replaceSessionEnvelope/u)

  const stageStart = worker.indexOf("if (message.action === 'stage-credential')")
  const pageReadyStart = worker.indexOf("if (message.action === 'page-ready')")
  const saveStart = worker.indexOf("if (message.action === 'save-pending')")
  const stageBlock = worker.slice(stageStart, pageReadyStart)
  const pageReadyBlock = worker.slice(pageReadyStart, worker.indexOf("if (message.action === 'undo-auto-update')"))
  const saveBlock = worker.slice(saveStart, worker.indexOf("throw new Error('Unknown content-script action.')"))
  const mutationHelper = worker.slice(
    worker.indexOf('function pendingCaptureMutation'),
    worker.indexOf('async function authorizeFill'),
  )
  assert.doesNotMatch(stageBlock, /commitPendingCapture|replaceSessionEnvelope/u)
  assert.match(pageReadyBlock, /automaticUpdateEligible/u)
  assert.match(pageReadyBlock, /successEvidence === true/u)
  assert.match(pageReadyBlock, /commitPendingCapture/u)
  assert.match(saveBlock, /commitPendingCapture/u)
  assert.match(mutationHelper, /replaceSessionEnvelope/u)
  assert.match(mutationHelper, /passwordHistory/u)
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
  assert.match(worker, /if \(message\.action === 'request-credentials'\) \{\s*const active = await unlockedSession\(\{ allowMissing: true \}\)/u)
  assert.match(worker, /locked: true, error: 'Hush is locked\.'/u)
  assert.match(worker, /if \(message\.action === 'generate-password'\)[\s\S]*?const active = await unlockedSession\(\)/u)
  const summaryBlock = worker.slice(worker.indexOf('function credentialSummary'), worker.indexOf('function matchesForPage'))
  assert.doesNotMatch(summaryBlock, /password/u)
})

test('locked inline controls open trusted unlock UI and resume only the originating live field', async () => {
  const [content, worker, popup, messages] = await Promise.all([
    read('extension/src/content.js'),
    read('extension/src/service-worker.js'),
    read('extension/src/popup.js'),
    read('extension/src/messagePolicy.js'),
  ])
  assert.match(content, /action: 'request-unlock'/u)
  assert.match(content, /pending\.requestId === message\.requestId/u)
  assert.match(content, /pending\.pageUrl === location\.href/u)
  assert.match(content, /pending\.input\.isConnected/u)
  assert.match(content, /openPanel\(\{ automatic: false \}\)/u)
  assert.match(worker, /createUnlockHandoff/u)
  assert.match(worker, /unlockHandoffMatchesTab/u)
  assert.match(worker, /action: 'resume-after-unlock'/u)
  assert.match(worker, /chrome\.action\.openPopup/u)
  assert.match(worker, /chrome\.windows\.create/u)
  assert.match(worker, /UNLOCK_HANDOFF_ALARM/u)
  assert.match(worker, /handoff\.createdAt \+ UNLOCK_HANDOFF_TTL/u)
  assert.match(popup, /response\.resumed\) window\.close\(\)/u)
  assert.match(messages, /'request-unlock'/u)
})

test('pending credentials, multi-step state, and rollback survive worker sleep only as DEK-encrypted session records', async () => {
  const worker = await read('extension/src/service-worker.js')
  assert.match(worker, /sealEphemeralState/u)
  assert.match(worker, /openEphemeralState/u)
  assert.match(worker, /chrome\.storage\.session\.set/u)
  assert.match(worker, /pendingCredentialCapture:/u)
  assert.match(worker, /multiStepLoginContext:/u)
  assert.match(worker, /automaticUpdateUndo:/u)
  assert.match(worker, /'automatic-update-undo'/u)
  assert.doesNotMatch(worker, /const pendingCaptures = new Map|const multiStepContexts = new Map/u)
  assert.match(worker, /const fillAuthorizations = new Map/u)
})

test('suggestions dismiss softly and submission success uses continuing DOM evidence', async () => {
  const content = await read('extension/src/content.js')
  assert.match(content, /event\.composedPath\(\)\.includes\(host\)/u)
  assert.match(content, /event\.key === 'Escape'/u)
  assert.match(content, /capturePotentialSubmission/u)
  assert.match(content, /watchForSuccessfulTransition/u)
  assert.match(content, /new MutationObserver/u)
  assert.match(content, /successEvidence/u)
  assert.match(content, /failureEvidence: pageShowsFailure\(\)/u)
  assert.match(await read('extension/src/service-worker.js'), /message\.failureEvidence === true/u)
  assert.doesNotMatch(content, /1_?800/u)
})

test('new-password recognition handles token lists, shown passwords, confirmation mismatches, and Enter submissions', async () => {
  const [content, detection, capture] = await Promise.all([
    read('extension/src/content.js'),
    read('extension/src/formDetection.js'),
    read('extension/src/captureDetection.js'),
  ])
  assert.match(detection, /autocomplete\.split/u)
  assert.match(detection, /one-time-code/u)
  assert.match(content, /credentialFieldRole/u)
  assert.match(content, /event\.key === 'Enter'/u)
  assert.match(content, /addEventListener\('click', capturePotentialSubmission/u)
  assert.match(content, /container instanceof HTMLFormElement/u)
  assert.match(content, /visibleActions\.length !== 1/u)
  assert.match(content, /ambiguousPasswordCount/u)
  assert.match(capture, /password-mismatch/u)
  assert.match(capture, /generic\.length >= 3/u)
  assert.match(capture, /inferredCaptureKind/u)
  const worker = await read('extension/src/service-worker.js')
  assert.match(worker, /message\.failureEvidence === true[\s\S]*?removePendingCapture/u)
})

test('Never auto-lock requires an explicit warning acknowledgement', async () => {
  const [options, manager] = await Promise.all([read('extension/src/options.js'), read('src/App.jsx')])
  assert.match(options, /neverAcknowledgement/u)
  assert.match(options, /understand the risk before disabling inactivity locking/u)
  assert.match(manager, /window\.confirm\('Never disables inactivity locking/u)
})

test('automatic password updates are opt-in, exact-only, serialized, and undoable', async () => {
  const [worker, content, options, manager, messages] = await Promise.all([
    read('extension/src/service-worker.js'),
    read('extension/src/content.js'),
    read('extension/src/options.js'),
    read('src/App.jsx'),
    read('extension/src/messagePolicy.js'),
  ])
  assert.match(worker, /autoUpdateExactPasswords === true/u)
  assert.match(worker, /autoUpdateExactPasswords: false/u)
  assert.match(worker, /pending\.automaticUpdateEligible === true/u)
  assert.match(worker, /message\.successEvidence === true/u)
  assert.match(worker, /storeAutomaticUpdateUndo/u)
  assert.match(worker, /restoreAutomaticUpdate/u)
  assert.match(worker, /withTabCaptureLock/u)
  assert.match(content, /showAutoUpdateNotice/u)
  assert.match(content, /action: 'undo-auto-update'/u)
  assert.match(content, /positionNotice\(\)/u)
  assert.match(options, /Update exact-match passwords after successful sign-in/u)
  assert.match(manager, /Automatic exact-password updates/u)
  assert.match(messages, /'undo-auto-update'/u)
})
