import {
  changeMasterPasswordEnvelope,
  createVaultEnvelope,
  importSessionDataKey,
  LEGACY_FORMAT,
  migrateLegacyVaultEnvelope,
  openCurrentVaultEnvelope,
  openVaultWithDataKey,
  persistVaultEnvelope,
  recoverAndRewrapVaultEnvelope,
} from '../../src/lib/vaultCryptoCore.js'
import { generatePassword } from '../../src/lib/passwordGenerator.js'
import { masterPasswordHealth } from '../../src/lib/passwordRisk.js'
import { deserializeEnvelope, serializeEnvelope } from '../../src/lib/vaultTransfer.js'
import { automaticMatch, normalizeFormRequest } from './autofillPolicy.js'
import { automaticPasswordUpdateEligible, createAutomaticUpdateUndo, restoreAutomaticUpdate } from './autoUpdatePolicy.js'
import { credentialCaptureOperation, existingCredentialForCapture } from './capturePolicy.js'
import { credentialsForPage } from './domainMatch.js'
import { openEphemeralState, sealEphemeralState } from './ephemeralState.js'
import { actionAllowed, classifyMessageSender, externalActionAllowed } from './messagePolicy.js'
import {
  createSessionRecord,
  normalizeAutoLockMinutes,
  sessionExpired,
  sessionRecordIsValid,
  touchSessionRecord,
} from './sessionPolicy.js'
import { createUnlockHandoff, UNLOCK_HANDOFF_TTL, unlockHandoffIsValid, unlockHandoffMatchesTab } from './unlockHandoffPolicy.js'

const STORAGE_KEY = 'encryptedVaultArchive'
const SESSION_KEY = 'unlockedVaultSession'
const PENDING_IMPORT_KEY = 'pendingEncryptedWebVault'
const PENDING_AUTH_KEY = 'pendingAuthenticatedEnvelope'
const UNLOCK_HANDOFF_KEY = 'pendingUnlockHandoff'
const AUTO_LOCK_ALARM = 'hush-auto-lock'
const UNLOCK_HANDOFF_ALARM = 'hush-unlock-handoff-expiry'
const HUSH_WEB_ORIGINS = new Set(['https://hush-password-manager.vercel.app'])
const MAX_ARCHIVE_CHARACTERS = 50_000_000
const MAX_STAGED_ARCHIVE_CHARACTERS = 4_000_000
const MAX_SECRET_LENGTH = 4096
const FILL_AUTHORIZATION_TTL = 2 * 60_000
const MULTI_STEP_TTL = 5 * 60_000
const PENDING_CAPTURE_TTL = 10 * 60_000
const AUTO_UPDATE_UNDO_TTL = 10 * 60_000
const PENDING_CAPTURE_PREFIX = 'pendingCredentialCapture:'
const MULTI_STEP_PREFIX = 'multiStepLoginContext:'
const AUTO_UPDATE_UNDO_PREFIX = 'automaticUpdateUndo:'

const fillAuthorizations = new Map()
const captureCommitLocks = new Map()

const storageReady = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
])

function extensionOrigin() {
  return chrome.runtime.getURL('/')
}

function senderContext(sender) {
  return classifyMessageSender(sender, { extensionId: chrome.runtime.id, extensionOrigin: extensionOrigin() })
}

async function readStoredEnvelope() {
  await storageReady
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  if (!stored[STORAGE_KEY]) return null
  return deserializeEnvelope(stored[STORAGE_KEY])
}

async function storeEnvelope(envelope) {
  await storageReady
  await chrome.storage.local.set({ [STORAGE_KEY]: serializeEnvelope(envelope) })
}

function tabStateKey(prefix, tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Invalid tab context.')
  return `${prefix}${tabId}`
}

async function writeTabState(active, prefix, purpose, tabId, value, ttl) {
  const key = tabStateKey(prefix, tabId)
  const record = await sealEphemeralState(active.dataKey, { ...value, tabId }, {
    purpose,
    expiresAt: Date.now() + ttl,
  })
  await storageReady
  await chrome.storage.session.set({ [key]: record })
}

async function readTabState(active, prefix, purpose, tabId) {
  const key = tabStateKey(prefix, tabId)
  await storageReady
  const stored = await chrome.storage.session.get(key)
  if (!stored[key]) return null
  try {
    const value = await openEphemeralState(active.dataKey, stored[key], { purpose })
    if (value.tabId !== tabId) throw new Error('Temporary tab state mismatch.')
    return value
  } catch {
    await chrome.storage.session.remove(key)
    return null
  }
}

async function removeTabState(prefix, tabId) {
  await storageReady
  await chrome.storage.session.remove(tabStateKey(prefix, tabId))
}

async function removeAllEphemeralTabState() {
  await storageReady
  const stored = await chrome.storage.session.get(null)
  const keys = Object.keys(stored).filter((key) => key.startsWith(PENDING_CAPTURE_PREFIX) || key.startsWith(MULTI_STEP_PREFIX) || key.startsWith(AUTO_UPDATE_UNDO_PREFIX))
  if (keys.length) await chrome.storage.session.remove(keys)
}

async function clearSession() {
  await storageReady
  await chrome.storage.session.remove([SESSION_KEY, PENDING_AUTH_KEY, UNLOCK_HANDOFF_KEY])
  await removeAllEphemeralTabState()
  await Promise.all([chrome.alarms.clear(AUTO_LOCK_ALARM), chrome.alarms.clear(UNLOCK_HANDOFF_ALARM)])
  fillAuthorizations.clear()
  captureCommitLocks.clear()
}

function sessionPreferences(active) {
  return {
    autoLockMinutes: normalizeAutoLockMinutes(active?.payload?.preferences?.autoLockMinutes),
    clipboardClearSeconds: Number(active?.payload?.preferences?.clipboardClearSeconds ?? 30),
    passwordHistoryLimit: Number(active?.payload?.preferences?.passwordHistoryLimit ?? 5),
    autofillSingleExact: active?.payload?.preferences?.autofillSingleExact === true,
    autoUpdateExactPasswords: active?.payload?.preferences?.autoUpdateExactPasswords === true,
  }
}

async function scheduleSessionAlarm(record) {
  await chrome.alarms.clear(AUTO_LOCK_ALARM)
  if (record.expiresAt !== null) await chrome.alarms.create(AUTO_LOCK_ALARM, { when: record.expiresAt })
}

async function storeUnlockedSession({ envelope, payload, sessionKeyMaterial }) {
  const record = createSessionRecord({
    vaultId: envelope.vaultId,
    envelopeRevision: envelope.revision,
    sessionKeyMaterial,
    autoLockMinutes: payload?.preferences?.autoLockMinutes,
  })
  await storageReady
  await chrome.storage.session.set({ [SESSION_KEY]: record })
  await scheduleSessionAlarm(record)
  return record
}

async function readSessionRecord() {
  await storageReady
  const stored = await chrome.storage.session.get(SESSION_KEY)
  return stored[SESSION_KEY] || null
}

async function unlockedSession({ touch = true, allowMissing = false } = {}) {
  const record = await readSessionRecord()
  if (!sessionRecordIsValid(record) || sessionExpired(record)) {
    if (record) await clearSession()
    if (allowMissing) return null
    throw new Error(record ? 'Hush locked after inactivity. Unlock it again.' : 'Unlock Hush from the extension first.')
  }
  const envelope = await readStoredEnvelope()
  if (!envelope || envelope.vaultId !== record.vaultId || envelope.revision !== record.envelopeRevision) {
    await clearSession()
    if (allowMissing) return null
    throw new Error('The encrypted vault changed, so Hush locked safely.')
  }
  try {
    const dataKey = await importSessionDataKey(record.sessionKeyMaterial)
    const payload = await openVaultWithDataKey(dataKey, envelope)
    const active = { dataKey, envelope, payload, sessionRecord: record }
    if (touch) {
      const nextRecord = touchSessionRecord(record, sessionPreferences(active).autoLockMinutes)
      await chrome.storage.session.set({ [SESSION_KEY]: nextRecord })
      await scheduleSessionAlarm(nextRecord)
      active.sessionRecord = nextRecord
    }
    return active
  } catch (error) {
    await clearSession()
    if (allowMissing) return null
    throw error
  }
}

async function openEnvelope(password, envelope) {
  return envelope?.format === LEGACY_FORMAT
    ? migrateLegacyVaultEnvelope(password, envelope, { includeSessionKeyMaterial: true })
    : openCurrentVaultEnvelope(password, envelope, { includeSessionKeyMaterial: true })
}

async function replaceSessionEnvelope(payload) {
  const active = await unlockedSession()
  const nextEnvelope = await persistVaultEnvelope(active.dataKey, active.envelope, payload)
  await storeEnvelope(nextEnvelope)
  await storeUnlockedSession({ envelope: nextEnvelope, payload, sessionKeyMaterial: active.sessionRecord.sessionKeyMaterial })
  return { ...active, envelope: nextEnvelope, payload }
}

function safeText(value, maxLength) {
  return String(value || '').normalize('NFKC').slice(0, maxLength)
}

function safeSecret(value, maxLength = MAX_SECRET_LENGTH) {
  return String(value || '').slice(0, maxLength)
}

function validatePayload(payload) {
  if (!payload || Number(payload.schemaVersion) !== 2 || !Array.isArray(payload.items)) throw new Error('Invalid vault payload.')
  if (payload.items.length > 100_000) throw new Error('That vault contains too many records.')
  if (JSON.stringify(payload).length > MAX_ARCHIVE_CHARACTERS) throw new Error('That vault is too large for this Hush build.')
  return payload
}

async function readPendingArchive() {
  await storageReady
  const stored = await chrome.storage.session.get(PENDING_IMPORT_KEY)
  return typeof stored[PENDING_IMPORT_KEY] === 'string' ? stored[PENDING_IMPORT_KEY] : ''
}

async function clearPendingArchive() {
  await storageReady
  await chrome.storage.session.remove(PENDING_IMPORT_KEY)
  await chrome.action.setBadgeText({ text: '' })
}

async function readUnlockHandoff() {
  await storageReady
  const stored = await chrome.storage.session.get(UNLOCK_HANDOFF_KEY)
  const handoff = stored[UNLOCK_HANDOFF_KEY]
  if (!unlockHandoffIsValid(handoff)) {
    if (handoff) await chrome.storage.session.remove(UNLOCK_HANDOFF_KEY)
    return null
  }
  return handoff
}

async function storeUnlockHandoff(handoff) {
  await storageReady
  await chrome.storage.session.set({ [UNLOCK_HANDOFF_KEY]: handoff })
  await chrome.alarms.create(UNLOCK_HANDOFF_ALARM, { when: handoff.createdAt + UNLOCK_HANDOFF_TTL })
}

async function removeUnlockHandoff() {
  await storageReady
  await chrome.storage.session.remove(UNLOCK_HANDOFF_KEY)
  await chrome.alarms.clear(UNLOCK_HANDOFF_ALARM)
}

async function completeUnlockHandoff() {
  const handoff = await readUnlockHandoff()
  if (!handoff) return false
  try {
    const tab = await chrome.tabs.get(handoff.tabId)
    if (!unlockHandoffMatchesTab(handoff, tab)) return false
    const response = await chrome.tabs.sendMessage(handoff.tabId, {
      action: 'resume-after-unlock',
      requestId: handoff.requestId,
      origin: handoff.origin,
    }, { frameId: 0 })
    return response?.ok === true
  } catch {
    return false
  } finally {
    await removeUnlockHandoff()
  }
}

async function openUnlockSurface(windowId, requestId) {
  try {
    if (typeof chrome.action.openPopup !== 'function') throw new Error('Action popup unavailable.')
    await chrome.action.openPopup({ windowId })
    return 'action-popup'
  } catch {
    await chrome.windows.create({
      url: chrome.runtime.getURL(`popup.html?handoff=${encodeURIComponent(requestId)}`),
      type: 'popup',
      width: 390,
      height: 590,
      focused: true,
    })
    return 'window'
  }
}

async function stageAuthenticatedEnvelope(opened) {
  await storageReady
  await chrome.storage.session.set({
    [PENDING_AUTH_KEY]: {
      archive: serializeEnvelope(opened.envelope),
      sessionKeyMaterial: opened.sessionKeyMaterial,
      expiresAt: Date.now() + 5 * 60_000,
    },
  })
}

async function consumeAuthenticatedEnvelope(envelope) {
  await storageReady
  const stored = await chrome.storage.session.get(PENDING_AUTH_KEY)
  const pending = stored[PENDING_AUTH_KEY]
  await chrome.storage.session.remove(PENDING_AUTH_KEY)
  if (!pending || pending.expiresAt < Date.now() || pending.archive !== serializeEnvelope(envelope) || typeof pending.sessionKeyMaterial !== 'string') {
    throw new Error('That authenticated vault transfer expired. Authenticate it again.')
  }
  return pending.sessionKeyMaterial
}

function credentialSummary(entry, match, multiStep) {
  return {
    id: entry.id,
    name: safeText(entry.name, 160),
    username: safeText(entry.username, 512),
    hostname: match.page.hostname,
    fillable: Boolean(match.fillable),
    matchType: match.matchType || '',
    preferred: Boolean(multiStep && (
      multiStep.credentialId === entry.id
      || (!multiStep.credentialId && multiStep.username && multiStep.username === entry.username)
    )),
    warning: match.fillable ? (match.requiresConfirmation ? match.reason : '') : match.reason,
  }
}

function matchesForPage(active, pageUrl) {
  return credentialsForPage(active.payload.items || [], pageUrl)
}

async function trustedCurrentPage(context, reportedPageUrl = '') {
  const currentTab = await chrome.tabs.get(context.tabId)
  if (!currentTab?.url) throw new Error('Hush could not verify the current page.')
  let current
  try {
    current = new URL(currentTab.url)
  } catch {
    throw new Error('Hush could not verify the current page.')
  }
  if (current.protocol !== 'https:' || current.origin !== context.url.origin) throw new Error('The page changed before Hush could continue.')
  if (reportedPageUrl) {
    let reported
    try {
      reported = new URL(String(reportedPageUrl).slice(0, 4096))
    } catch {
      throw new Error('Hush received an invalid page context.')
    }
    if (reported.origin !== context.url.origin || reported.href !== current.href) throw new Error('The page changed before Hush could continue.')
  }
  return current
}

async function currentMultiStepContext(active, tabId, origin) {
  const value = await readTabState(active, MULTI_STEP_PREFIX, 'multi-step-login', tabId)
  if (!value) return null
  if (value.origin !== origin) {
    await removeTabState(MULTI_STEP_PREFIX, tabId)
    return null
  }
  return value
}

async function storeMultiStepContext(active, tabId, value) {
  await writeTabState(active, MULTI_STEP_PREFIX, 'multi-step-login', tabId, value, MULTI_STEP_TTL)
}

async function readPendingCapture(active, tabId) {
  return readTabState(active, PENDING_CAPTURE_PREFIX, 'pending-credential', tabId)
}

async function storePendingCapture(active, tabId, value) {
  await writeTabState(active, PENDING_CAPTURE_PREFIX, 'pending-credential', tabId, value, PENDING_CAPTURE_TTL)
}

async function removePendingCapture(tabId) {
  await removeTabState(PENDING_CAPTURE_PREFIX, tabId)
}

async function removeMultiStepContext(tabId) {
  await removeTabState(MULTI_STEP_PREFIX, tabId)
}

async function readAutomaticUpdateUndo(active, tabId) {
  return readTabState(active, AUTO_UPDATE_UNDO_PREFIX, 'automatic-update-undo', tabId)
}

async function storeAutomaticUpdateUndo(active, tabId, value) {
  await writeTabState(active, AUTO_UPDATE_UNDO_PREFIX, 'automatic-update-undo', tabId, value, AUTO_UPDATE_UNDO_TTL)
}

async function removeAutomaticUpdateUndo(tabId) {
  await removeTabState(AUTO_UPDATE_UNDO_PREFIX, tabId)
}

function authorizeMatches(tabId, page, matches) {
  const now = Date.now()
  for (const [id, authorization] of fillAuthorizations) {
    if (now - authorization.createdAt > FILL_AUTHORIZATION_TTL) fillAuthorizations.delete(id)
  }
  const requestId = crypto.randomUUID()
  fillAuthorizations.set(requestId, {
    tabId,
    requestId,
    pageUrl: page.href,
    origin: page.origin,
    credentialIds: matches.map(({ entry }) => entry.id),
    createdAt: Date.now(),
  })
  return requestId
}

function clearFillAuthorizationsForTab(tabId) {
  for (const [requestId, authorization] of fillAuthorizations) {
    if (authorization.tabId === tabId) fillAuthorizations.delete(requestId)
  }
}

async function sendCredentialToPage(context, page, candidate, mode) {
  const verifiedPage = await trustedCurrentPage(context, page.href)
  const credential = { mode, expectedPageUrl: verifiedPage.href }
  if (mode === 'username-step' || mode === 'login') credential.username = candidate.entry.username || ''
  if (mode !== 'username-step') credential.password = candidate.entry.password
  const response = await chrome.tabs.sendMessage(context.tabId, { action: 'perform-fill', credential }, { frameId: 0 })
  if (!response?.ok) throw new Error('The login fields changed before Hush could fill them.')
}

function pendingCaptureMutation(active, pending, now = new Date().toISOString()) {
  const historyLimit = sessionPreferences(active).passwordHistoryLimit
  if (pending.operation === 'update') {
    const previousEntry = pending.credentialId && active.payload.items.find((entry) => entry.id === pending.credentialId)
    if (!previousEntry) throw new Error('Hush could not identify the existing credential, so it did not overwrite anything.')
    const updatedEntry = {
      ...previousEntry,
      username: pending.username || previousEntry.username,
      passwordHistory: historyLimit > 0 && previousEntry.password !== pending.password
        ? [{ password: previousEntry.password, changedAt: now }, ...(previousEntry.passwordHistory || [])].slice(0, historyLimit)
        : (previousEntry.passwordHistory || []),
      password: pending.password,
      passwordChangedAt: now,
      updatedAt: now,
      revision: (previousEntry.revision || 1) + 1,
      encryptionVersion: 2,
    }
    return {
      previousEntry,
      updatedEntry,
      items: active.payload.items.map((entry) => entry.id === previousEntry.id ? updatedEntry : entry),
    }
  }
  if (pending.operation !== 'save') throw new Error('Unsupported pending credential operation.')
  const updatedEntry = {
    id: crypto.randomUUID(),
    name: pending.hostname,
    username: pending.username,
    password: pending.password,
    url: pending.origin,
    notes: 'Saved after user confirmation in the Hush extension.',
    collection: 'Personal',
    tags: [],
    favorite: false,
    createdAt: now,
    updatedAt: now,
    passwordChangedAt: now,
    passwordHistory: [],
    revision: 1,
    encryptionVersion: 2,
  }
  return { previousEntry: null, updatedEntry, items: [updatedEntry, ...active.payload.items] }
}

async function commitPendingCapture(active, pending, mutation = pendingCaptureMutation(active, pending)) {
  await replaceSessionEnvelope({ ...active.payload, items: mutation.items })
  return mutation
}

function withTabCaptureLock(tabId, task) {
  const previous = captureCommitLocks.get(tabId) || Promise.resolve()
  const current = previous.catch(() => {}).then(task)
  captureCommitLocks.set(tabId, current)
  return current.finally(() => {
    if (captureCommitLocks.get(tabId) === current) captureCommitLocks.delete(tabId)
  })
}

async function handleContentMessage(message, context) {
  if (!actionAllowed('content', message.action)) throw new Error('Unknown or disallowed content-script action.')
  if (message.action === 'request-unlock') {
    const page = await trustedCurrentPage(context, message.pageUrl)
    const handoff = createUnlockHandoff({
      requestId: message.requestId,
      tabId: context.tabId,
      windowId: context.windowId,
      pageUrl: page.href,
    })
    const active = await unlockedSession({ touch: false, allowMissing: true })
    await storeUnlockHandoff(handoff)
    if (active) return { ok: true, resumed: await completeUnlockHandoff() }
    return { ok: true, opened: await openUnlockSurface(handoff.windowId, handoff.requestId) }
  }
  if (message.action === 'request-credentials') {
    const active = await unlockedSession({ allowMissing: true })
    if (!active) return { ok: false, locked: true, error: 'Hush is locked.' }
    const page = await trustedCurrentPage(context, message.pageUrl)
    const matches = matchesForPage(active, page.href)
    const multiStep = await currentMultiStepContext(active, context.tabId, page.origin)
    const requestId = authorizeMatches(context.tabId, page, matches)
    const formRequest = normalizeFormRequest(message.form)
    const automatic = automaticMatch(matches, sessionPreferences(active), formRequest, multiStep)
    if (automatic) {
      const mode = formRequest.formKind === 'password-change' ? 'current-password' : 'login'
      await sendCredentialToPage(context, page, automatic, mode)
      fillAuthorizations.delete(requestId)
      if (automatic.reason === 'multi-step-selection') await removeMultiStepContext(context.tabId)
    }
    return {
      ok: true,
      requestId,
      autofilled: Boolean(automatic),
      credentials: matches.map(({ entry, match }) => credentialSummary(entry, match, multiStep)),
    }
  }
  if (message.action === 'fill-credential') {
    const active = await unlockedSession()
    const page = await trustedCurrentPage(context, message.pageUrl)
    if (typeof message.credentialId !== 'string' || message.credentialId.length > 200) throw new Error('Invalid credential selection.')
    const authorization = fillAuthorizations.get(message.requestId)
    if (!authorization
      || authorization.tabId !== context.tabId
      || authorization.requestId !== message.requestId
      || authorization.origin !== page.origin
      || authorization.pageUrl !== page.href
      || Date.now() - authorization.createdAt > FILL_AUTHORIZATION_TTL
      || !authorization.credentialIds.includes(message.credentialId)) {
      throw new Error('That Hush suggestion expired after the page changed. Focus the field again.')
    }
    const candidate = matchesForPage(active, page.href).find(({ entry }) => entry.id === message.credentialId)
    if (!candidate || !candidate.match.fillable) throw new Error(candidate?.match.reason || 'That credential is not safe to fill on this page.')
    const formRequest = normalizeFormRequest(message.form)
    const mode = formRequest.formKind === 'username-step'
      ? 'username-step'
      : formRequest.formKind === 'password-change'
        ? 'current-password'
        : 'login'
    await sendCredentialToPage(context, page, candidate, mode)
    fillAuthorizations.delete(message.requestId)
    if (mode === 'username-step') {
      await storeMultiStepContext(active, context.tabId, {
        origin: page.origin,
        credentialId: candidate.entry.id,
        username: safeText(candidate.entry.username, 512),
        explicitSelection: true,
      })
    } else {
      await removeMultiStepContext(context.tabId)
    }
    return { ok: true }
  }
  if (message.action === 'generate-password') {
    const page = await trustedCurrentPage(context, message.pageUrl)
    const active = await unlockedSession()
    const password = generatePassword()
    const capture = message.capture
    if (capture && ['registration', 'password-change'].includes(capture.kind)) {
      const multiStep = await currentMultiStepContext(active, context.tabId, page.origin)
      const username = safeText(capture.username || multiStep?.username, 512)
      const currentPassword = safeSecret(capture.currentPassword)
      const matches = matchesForPage(active, page.href)
      const existing = existingCredentialForCapture(matches, {
        kind: capture.kind,
        username,
        currentPassword,
        credentialId: multiStep?.credentialId,
      })
      await storePendingCapture(active, context.tabId, {
        status: 'generated',
        source: 'generated',
        kind: capture.kind,
        operation: credentialCaptureOperation(existing, password),
        origin: page.origin,
        pageUrl: page.href,
        hostname: page.hostname,
        username,
        password,
        credentialId: existing?.entry.id || '',
        createdAt: Date.now(),
      })
    }
    return { ok: true, password }
  }
  if (message.action === 'stage-login-step') {
    const page = await trustedCurrentPage(context, message.pageUrl)
    const active = await unlockedSession()
    const username = safeText(message.username, 512)
    if (!username) return { ok: true, staged: false }
    const usernameMatches = matchesForPage(active, page.href).filter(({ entry }) => entry.username === username)
    await storeMultiStepContext(active, context.tabId, {
      origin: page.origin,
      credentialId: usernameMatches.length === 1 ? usernameMatches[0].entry.id : '',
      username,
      explicitSelection: false,
    })
    return { ok: true, staged: true }
  }
  if (message.action === 'stage-credential') {
    const page = await trustedCurrentPage(context, message.pageUrl)
    const active = await unlockedSession()
    const capture = message.capture
    if (!capture || !['login', 'registration', 'password-change'].includes(capture.kind)) throw new Error('Unsupported credential capture.')
    const multiStep = await currentMultiStepContext(active, context.tabId, page.origin)
    const username = safeText(capture.username || multiStep?.username, 512)
    const password = safeSecret(capture.password)
    const currentPassword = safeSecret(capture.currentPassword)
    if (!password) throw new Error('No password was captured.')
    const generatedCandidate = await readPendingCapture(active, context.tabId)
    const matches = matchesForPage(active, page.href)
    const existing = existingCredentialForCapture(matches, {
      kind: capture.kind,
      username,
      currentPassword,
      credentialId: multiStep?.credentialId,
    })
    const operation = credentialCaptureOperation(existing, password)
    if (operation === 'unchanged') {
      await Promise.all([removePendingCapture(context.tabId), removeMultiStepContext(context.tabId)])
      clearFillAuthorizationsForTab(context.tabId)
      return { ok: true, staged: false, unchanged: true }
    }
    const usernameMatches = username ? matches.filter(({ entry }) => entry.username === username) : []
    const identifiedUnambiguously = Boolean(existing && (
      (multiStep?.credentialId && existing.entry.id === multiStep.credentialId)
      || usernameMatches.length === 1
      || (!username && matches.length === 1)
    ))
    const automaticUpdateEligible = automaticPasswordUpdateEligible({
      preferenceEnabled: true,
      kind: capture.kind,
      operation,
      existing,
      identifiedUnambiguously,
      ambiguousForm: capture.ambiguousForm === true,
    })
    await storePendingCapture(active, context.tabId, {
      status: 'submitted',
      source: generatedCandidate?.status === 'generated'
        && generatedCandidate.origin === page.origin
        && generatedCandidate.password === password ? 'generated' : 'typed',
      kind: capture.kind,
      operation,
      origin: page.origin,
      pageUrl: page.href,
      hostname: page.hostname,
      username,
      password,
      credentialId: existing?.entry.id || '',
      automaticUpdateEligible,
      createdAt: Date.now(),
    })
    await removeMultiStepContext(context.tabId)
    clearFillAuthorizationsForTab(context.tabId)
    return { ok: true, staged: true, operation }
  }
  if (message.action === 'page-ready') {
    return withTabCaptureLock(context.tabId, async () => {
      const page = await trustedCurrentPage(context, message.pageUrl)
      const active = await unlockedSession({ touch: false })
      const pending = await readPendingCapture(active, context.tabId)
      if (!pending || pending.origin !== page.origin) {
        if (pending) await removePendingCapture(context.tabId)
        return { ok: true, pending: null }
      }
      if (pending.status !== 'submitted') return { ok: true, pending: null, awaitingSuccess: true }
      if (message.failureEvidence === true) {
        await removePendingCapture(context.tabId)
        return { ok: true, pending: null, captureRejected: true }
      }
      if (page.href === pending.pageUrl && message.successEvidence !== true) return { ok: true, pending: null, awaitingSuccess: true }
      if (pending.automaticUpdateEligible === true
        && sessionPreferences(active).autoUpdateExactPasswords === true
        && message.successEvidence === true) {
        const mutation = pendingCaptureMutation(active, pending)
        const undo = createAutomaticUpdateUndo(mutation.previousEntry, mutation.updatedEntry, {
          origin: pending.origin,
          hostname: pending.hostname,
        })
        await storeAutomaticUpdateUndo(active, context.tabId, undo)
        try {
          await commitPendingCapture(active, pending, mutation)
        } catch (error) {
          await removeAutomaticUpdateUndo(context.tabId)
          throw error
        }
        await Promise.all([removePendingCapture(context.tabId), removeMultiStepContext(context.tabId)])
        return {
          ok: true,
          pending: null,
          autoUpdated: { hostname: pending.hostname, username: pending.username, canUndo: true },
        }
      }
      return { ok: true, pending: { kind: pending.kind, operation: pending.operation, hostname: pending.hostname, username: pending.username } }
    })
  }
  if (message.action === 'undo-auto-update') {
    return withTabCaptureLock(context.tabId, async () => {
      const active = await unlockedSession()
      const page = await trustedCurrentPage(context, message.pageUrl)
      const undo = await readAutomaticUpdateUndo(active, context.tabId)
      if (!undo || undo.origin !== page.origin) throw new Error('That automatic update can no longer be undone.')
      const current = active.payload.items.find((entry) => entry.id === undo.credentialId)
      const restored = restoreAutomaticUpdate(current, undo)
      const items = active.payload.items.map((entry) => entry.id === restored.id ? restored : entry)
      await replaceSessionEnvelope({ ...active.payload, items })
      await removeAutomaticUpdateUndo(context.tabId)
      return { ok: true }
    })
  }
  if (message.action === 'discard-pending') {
    return withTabCaptureLock(context.tabId, async () => {
      await Promise.all([removePendingCapture(context.tabId), removeMultiStepContext(context.tabId)])
      return { ok: true }
    })
  }
  if (message.action === 'save-pending') {
    return withTabCaptureLock(context.tabId, async () => {
      const active = await unlockedSession()
      const page = await trustedCurrentPage(context, message.pageUrl)
      const pending = await readPendingCapture(active, context.tabId)
      if (!pending || pending.origin !== page.origin || pending.status !== 'submitted') throw new Error('That pending credential expired.')
      await commitPendingCapture(active, pending)
      await Promise.all([removePendingCapture(context.tabId), removeMultiStepContext(context.tabId)])
      return { ok: true }
    })
  }
  throw new Error('Unknown content-script action.')
}

async function handleExtensionMessage(message) {
  if (!actionAllowed('extension', message.action)) throw new Error('Unknown extension action.')
  if (message.action === 'status') {
    const envelope = await readStoredEnvelope()
    const active = await unlockedSession({ touch: false, allowMissing: true })
    const unlockHandoff = active ? null : await readUnlockHandoff()
    return {
      ok: true,
      hasVault: Boolean(envelope),
      unlocked: Boolean(active),
      format: envelope?.format || '',
      itemCount: active?.payload?.items?.length || 0,
      preferences: active ? sessionPreferences(active) : null,
      unlockHandoff: unlockHandoff ? { hostname: unlockHandoff.hostname } : null,
      externalArchiveWaiting: Boolean(await readPendingArchive()),
    }
  }
  if (message.action === 'unlock') {
    const envelope = await readStoredEnvelope()
    if (!envelope) throw new Error('Import or create an encrypted vault first.')
    const opened = await openEnvelope(safeSecret(message.password), envelope)
    if (opened.migrated) await storeEnvelope(opened.envelope)
    await storeUnlockedSession(opened)
    const resumed = await completeUnlockHandoff()
    return { ok: true, itemCount: opened.payload.items.length, migrated: Boolean(opened.migrated), archive: serializeEnvelope(opened.envelope), payload: opened.payload, resumed }
  }
  if (message.action === 'lock') {
    await clearSession()
    return { ok: true }
  }
  if (message.action === 'touch-session') {
    await unlockedSession()
    return { ok: true }
  }
  if (message.action === 'resume-vault') {
    const active = await unlockedSession()
    return { ok: true, archive: serializeEnvelope(active.envelope), payload: active.payload }
  }
  if (message.action === 'read-envelope') {
    const envelope = await readStoredEnvelope()
    return { ok: true, archive: envelope ? serializeEnvelope(envelope) : '' }
  }
  if (message.action === 'create-vault') {
    if (await readStoredEnvelope()) throw new Error('An encrypted extension vault already exists.')
    const password = safeSecret(message.password)
    if (!masterPasswordHealth(password).acceptable) throw new Error('Choose a longer, less predictable master password.')
    const payload = message.payload ? validatePayload(message.payload) : {
      schemaVersion: 2,
      items: [],
      preferences: { autoLockMinutes: 15, clipboardClearSeconds: 30, passwordHistoryLimit: 5, autofillSingleExact: false, autoUpdateExactPasswords: false },
    }
    const created = await createVaultEnvelope(password, payload, { includeSessionKeyMaterial: true })
    await storeEnvelope(created.envelope)
    await storeUnlockedSession(created)
    return { ok: true, recoveryKey: created.recoveryKey, archive: serializeEnvelope(created.envelope), payload: created.payload }
  }
  if (message.action === 'import-vault') {
    const archive = String(message.archive || await readPendingArchive()).slice(0, MAX_ARCHIVE_CHARACTERS)
    if (!archive) throw new Error('Choose a Hush backup first.')
    const envelope = deserializeEnvelope(archive)
    const opened = await openEnvelope(safeSecret(message.password), envelope)
    await storeEnvelope(opened.envelope)
    await clearPendingArchive()
    await storeUnlockedSession(opened)
    return { ok: true, itemCount: opened.payload.items.length, archive: serializeEnvelope(opened.envelope), payload: opened.payload }
  }
  if (message.action === 'export-vault') {
    const envelope = await readStoredEnvelope()
    if (!envelope) throw new Error('There is no encrypted vault to export.')
    return { ok: true, archive: serializeEnvelope(envelope, 2) }
  }
  if (message.action === 'replace-payload') {
    const active = await unlockedSession()
    if (Number(message.expectedRevision) !== active.envelope.revision) throw new Error('This vault changed in another Hush window. Reopen it before editing again.')
    const updated = await replaceSessionEnvelope(validatePayload(message.payload))
    return { ok: true, archive: serializeEnvelope(updated.envelope) }
  }
  if (message.action === 'authenticate-envelope') {
    const envelope = deserializeEnvelope(String(message.archive || '').slice(0, MAX_ARCHIVE_CHARACTERS))
    const opened = await openEnvelope(safeSecret(message.password), envelope)
    await stageAuthenticatedEnvelope(opened)
    return { ok: true, archive: serializeEnvelope(opened.envelope), payload: opened.payload }
  }
  if (message.action === 'install-envelope') {
    if (await readStoredEnvelope()) throw new Error('An encrypted extension vault already exists.')
    const envelope = deserializeEnvelope(String(message.archive || '').slice(0, MAX_ARCHIVE_CHARACTERS))
    const sessionKeyMaterial = await consumeAuthenticatedEnvelope(envelope)
    const dataKey = await importSessionDataKey(sessionKeyMaterial)
    const payload = await openVaultWithDataKey(dataKey, envelope)
    await storeEnvelope(envelope)
    await storeUnlockedSession({ envelope, payload, sessionKeyMaterial })
    return { ok: true, archive: serializeEnvelope(envelope), payload }
  }
  if (message.action === 'restore-envelope') {
    const current = await readStoredEnvelope()
    if (current && !message.replace) throw new Error('A local extension vault already exists. Confirm replacement first.')
    const envelope = deserializeEnvelope(String(message.archive || '').slice(0, MAX_ARCHIVE_CHARACTERS))
    const sessionKeyMaterial = await consumeAuthenticatedEnvelope(envelope)
    const dataKey = await importSessionDataKey(sessionKeyMaterial)
    const payload = await openVaultWithDataKey(dataKey, envelope)
    await storeEnvelope(envelope)
    await storeUnlockedSession({ envelope, payload, sessionKeyMaterial })
    return { ok: true, archive: serializeEnvelope(envelope), payload }
  }
  if (message.action === 'open-with-session') {
    const active = await unlockedSession()
    const envelope = deserializeEnvelope(String(message.archive || '').slice(0, MAX_ARCHIVE_CHARACTERS))
    if (envelope.vaultId !== active.envelope.vaultId) throw new Error('That encrypted envelope belongs to a different vault.')
    return { ok: true, payload: await openVaultWithDataKey(active.dataKey, envelope) }
  }
  if (message.action === 'apply-envelope') {
    const active = await unlockedSession()
    if (Number(message.expectedRevision) !== active.envelope.revision) throw new Error('This vault changed in another Hush window. Reopen it before editing again.')
    const envelope = deserializeEnvelope(String(message.archive || '').slice(0, MAX_ARCHIVE_CHARACTERS))
    if (envelope.vaultId !== active.envelope.vaultId) throw new Error('That encrypted envelope belongs to a different vault.')
    const payload = await openVaultWithDataKey(active.dataKey, envelope)
    await storeEnvelope(envelope)
    await storeUnlockedSession({ envelope, payload, sessionKeyMaterial: active.sessionRecord.sessionKeyMaterial })
    return { ok: true, archive: serializeEnvelope(envelope), payload }
  }
  if (message.action === 'change-master-password') {
    const active = await unlockedSession()
    const nextPassword = safeSecret(message.nextPassword)
    if (!masterPasswordHealth(nextPassword).acceptable) throw new Error('Choose a longer, less predictable master password.')
    const changed = await changeMasterPasswordEnvelope(active.envelope, safeSecret(message.currentPassword), nextPassword)
    await storeEnvelope(changed.envelope)
    await storeUnlockedSession({ envelope: changed.envelope, payload: changed.payload, sessionKeyMaterial: active.sessionRecord.sessionKeyMaterial })
    return { ok: true, archive: serializeEnvelope(changed.envelope), payload: changed.payload }
  }
  if (message.action === 'recover-vault') {
    const envelope = await readStoredEnvelope()
    if (!envelope) throw new Error('There is no extension vault to recover.')
    const nextPassword = safeSecret(message.nextPassword)
    if (!masterPasswordHealth(nextPassword).acceptable) throw new Error('Choose a longer, less predictable master password.')
    const recovered = await recoverAndRewrapVaultEnvelope(envelope, safeSecret(message.recoveryKey), nextPassword, { includeSessionKeyMaterial: true })
    await storeEnvelope(recovered.envelope)
    await storeUnlockedSession(recovered)
    return { ok: true, archive: serializeEnvelope(recovered.envelope), payload: recovered.payload }
  }
  if (message.action === 'delete-vault') {
    await clearSession()
    await chrome.storage.local.remove(STORAGE_KEY)
    await chrome.storage.session.remove([PENDING_IMPORT_KEY, PENDING_AUTH_KEY])
    await chrome.action.setBadgeText({ text: '' })
    return { ok: true }
  }
  if (message.action === 'update-settings') {
    const active = await unlockedSession()
    const preferences = { ...active.payload.preferences }
    if (message.settings?.autoLockMinutes !== undefined) {
      const value = Number(message.settings.autoLockMinutes)
      if (![0, 5, 15, 30, 60].includes(value)) throw new Error('Invalid auto-lock setting.')
      preferences.autoLockMinutes = value
    }
    if (message.settings?.passwordHistoryLimit !== undefined) {
      const value = Number(message.settings.passwordHistoryLimit)
      if (![0, 3, 5, 10].includes(value)) throw new Error('Invalid history setting.')
      preferences.passwordHistoryLimit = value
    }
    if (message.settings?.autofillSingleExact !== undefined) {
      if (typeof message.settings.autofillSingleExact !== 'boolean') throw new Error('Invalid autofill setting.')
      preferences.autofillSingleExact = message.settings.autofillSingleExact
    }
    if (message.settings?.autoUpdateExactPasswords !== undefined) {
      if (typeof message.settings.autoUpdateExactPasswords !== 'boolean') throw new Error('Invalid automatic-update setting.')
      preferences.autoUpdateExactPasswords = message.settings.autoUpdateExactPasswords
    }
    await replaceSessionEnvelope({ ...active.payload, preferences })
    return { ok: true, preferences }
  }
  if (message.action === 'page-summary') {
    const tab = await chrome.tabs.get(Number(message.tabId))
    if (!tab?.id || !tab.url) return { ok: true, hostname: '', matchCount: 0 }
    let page
    try {
      page = new URL(tab.url)
    } catch {
      return { ok: true, hostname: '', matchCount: 0 }
    }
    if (page.protocol !== 'https:') return { ok: true, hostname: page.hostname, matchCount: 0 }
    const active = await unlockedSession({ touch: false })
    return { ok: true, hostname: page.hostname, matchCount: matchesForPage(active, page.href).length }
  }
  throw new Error('Unknown extension action.')
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const context = senderContext(sender)
  const handler = context.kind === 'content' ? handleContentMessage : context.kind === 'extension' ? handleExtensionMessage : null
  if (!handler) {
    sendResponse({ ok: false, error: 'Untrusted message sender.' })
    return false
  }
  Promise.resolve(handler(message || {}, context))
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || 'Hush rejected that request.' }))
  return true
})

async function handleExternalMessage(message, sender) {
  let origin = ''
  try { origin = new URL(sender.url).origin } catch {}
  if (!HUSH_WEB_ORIGINS.has(origin)) throw new Error('Untrusted external request.')
  if (!externalActionAllowed(message?.action)) throw new Error('Untrusted external request.')
  if (message?.action === 'hush-status') {
    const envelope = await readStoredEnvelope()
    const record = await readSessionRecord()
    const unlocked = Boolean(
      envelope
      && sessionRecordIsValid(record)
      && !sessionExpired(record)
      && record.vaultId === envelope.vaultId
      && record.envelopeRevision === envelope.revision,
    )
    if (record && !unlocked) await clearSession()
    return { ok: true, installed: true, hasVault: Boolean(envelope), unlocked }
  }
  if (message?.action === 'open-manager') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('vault.html') })
    return { ok: true }
  }
  if (message?.action === 'open-import') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?mode=import') })
    return { ok: true }
  }
  if (message?.action === 'stage-encrypted-vault') {
    if (await readStoredEnvelope()) throw new Error('The extension already owns a vault. Hush will not overwrite it from a website.')
    if (typeof message.archive !== 'string' || !message.archive || message.archive.length > MAX_STAGED_ARCHIVE_CHARACTERS) throw new Error('That encrypted web vault is too large to stage safely. Export and import the .hush file instead.')
    deserializeEnvelope(message.archive)
    await storageReady
    await chrome.storage.session.set({ [PENDING_IMPORT_KEY]: message.archive })
    await chrome.action.setBadgeBackgroundColor({ color: '#60701f' })
    await chrome.action.setBadgeText({ text: '1' })
    return { ok: true, staged: true }
  }
  throw new Error('Untrusted external request.')
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  Promise.resolve(handleExternalMessage(message || {}, sender))
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || 'Hush rejected that external request.' }))
  return true
})

chrome.idle.onStateChanged.addListener((state) => {
  if (state === 'locked') void clearSession()
})
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UNLOCK_HANDOFF_ALARM) {
    void removeUnlockHandoff()
    return
  }
  if (alarm.name !== AUTO_LOCK_ALARM) return
  void (async () => {
    const record = await readSessionRecord()
    if (record && sessionExpired(record)) await clearSession()
    else if (record) await scheduleSessionAlarm(record)
  })()
})
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return
  clearFillAuthorizationsForTab(tabId)
  void (async () => {
    const handoff = await readUnlockHandoff()
    if (handoff?.tabId === tabId) await removeUnlockHandoff()
    let nextOrigin = ''
    try { nextOrigin = new URL(changeInfo.url).origin } catch {}
    const active = await unlockedSession({ touch: false, allowMissing: true })
    if (!active) return
    const [multiStep, pending, undo] = await Promise.all([
      readTabState(active, MULTI_STEP_PREFIX, 'multi-step-login', tabId),
      readPendingCapture(active, tabId),
      readAutomaticUpdateUndo(active, tabId),
    ])
    const removals = []
    if (multiStep && multiStep.origin !== nextOrigin) removals.push(removeMultiStepContext(tabId))
    if (pending && pending.origin !== nextOrigin) removals.push(removePendingCapture(tabId))
    if (undo && undo.origin !== nextOrigin) removals.push(removeAutomaticUpdateUndo(tabId))
    await Promise.all(removals)
  })().catch(() => {})
})
chrome.tabs.onRemoved.addListener((tabId) => {
  clearFillAuthorizationsForTab(tabId)
  void (async () => {
    const handoff = await readUnlockHandoff()
    await Promise.all([
      removeMultiStepContext(tabId),
      removePendingCapture(tabId),
      removeAutomaticUpdateUndo(tabId),
      handoff?.tabId === tabId ? removeUnlockHandoff() : Promise.resolve(),
    ])
  })().catch(() => {})
})
