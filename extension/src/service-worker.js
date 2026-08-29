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
import { credentialsForPage } from './domainMatch.js'
import { actionAllowed, classifyMessageSender, externalActionAllowed } from './messagePolicy.js'
import {
  createSessionRecord,
  normalizeAutoLockMinutes,
  sessionExpired,
  sessionRecordIsValid,
  touchSessionRecord,
} from './sessionPolicy.js'

const STORAGE_KEY = 'encryptedVaultArchive'
const SESSION_KEY = 'unlockedVaultSession'
const PENDING_IMPORT_KEY = 'pendingEncryptedWebVault'
const PENDING_AUTH_KEY = 'pendingAuthenticatedEnvelope'
const AUTO_LOCK_ALARM = 'hush-auto-lock'
const HUSH_WEB_ORIGINS = new Set(['https://hush-password-manager.vercel.app'])
const MAX_ARCHIVE_CHARACTERS = 50_000_000
const MAX_STAGED_ARCHIVE_CHARACTERS = 4_000_000
const MAX_SECRET_LENGTH = 4096
const FILL_AUTHORIZATION_TTL = 2 * 60_000
const MULTI_STEP_TTL = 5 * 60_000

const pendingCaptures = new Map()
const fillAuthorizations = new Map()
const multiStepContexts = new Map()

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

async function clearSession() {
  await storageReady
  await chrome.storage.session.remove([SESSION_KEY, PENDING_AUTH_KEY])
  await chrome.alarms.clear(AUTO_LOCK_ALARM)
  pendingCaptures.clear()
  fillAuthorizations.clear()
  multiStepContexts.clear()
}

function sessionPreferences(active) {
  return {
    autoLockMinutes: normalizeAutoLockMinutes(active?.payload?.preferences?.autoLockMinutes),
    clipboardClearSeconds: Number(active?.payload?.preferences?.clipboardClearSeconds ?? 30),
    passwordHistoryLimit: Number(active?.payload?.preferences?.passwordHistoryLimit ?? 5),
    autofillSingleExact: active?.payload?.preferences?.autofillSingleExact === true,
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

function currentMultiStepContext(tabId, origin) {
  const value = multiStepContexts.get(tabId)
  if (!value) return null
  if (value.origin !== origin || Date.now() - value.createdAt > MULTI_STEP_TTL) {
    multiStepContexts.delete(tabId)
    return null
  }
  return value
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

async function handleContentMessage(message, context) {
  if (!actionAllowed('content', message.action)) throw new Error('Unknown or disallowed content-script action.')
  if (message.action === 'request-credentials') {
    const active = await unlockedSession()
    const page = await trustedCurrentPage(context, message.pageUrl)
    const matches = matchesForPage(active, page.href)
    const multiStep = currentMultiStepContext(context.tabId, page.origin)
    const requestId = authorizeMatches(context.tabId, page, matches)
    const formRequest = normalizeFormRequest(message.form)
    const automatic = automaticMatch(matches, sessionPreferences(active), formRequest, multiStep)
    if (automatic) {
      const mode = formRequest.formKind === 'password-change' ? 'current-password' : 'login'
      await sendCredentialToPage(context, page, automatic, mode)
      fillAuthorizations.delete(requestId)
      if (automatic.reason === 'multi-step-selection') multiStepContexts.delete(context.tabId)
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
      multiStepContexts.set(context.tabId, {
        origin: page.origin,
        credentialId: candidate.entry.id,
        username: safeText(candidate.entry.username, 512),
        explicitSelection: true,
        createdAt: Date.now(),
      })
    } else {
      multiStepContexts.delete(context.tabId)
    }
    return { ok: true }
  }
  if (message.action === 'generate-password') {
    await unlockedSession()
    await trustedCurrentPage(context, message.pageUrl)
    return { ok: true, password: generatePassword() }
  }
  if (message.action === 'stage-login-step') {
    const active = await unlockedSession()
    const page = await trustedCurrentPage(context, message.pageUrl)
    const username = safeText(message.username, 512)
    if (!username) return { ok: true, staged: false }
    const usernameMatches = matchesForPage(active, page.href).filter(({ entry }) => entry.username === username)
    multiStepContexts.set(context.tabId, {
      origin: page.origin,
      credentialId: usernameMatches.length === 1 ? usernameMatches[0].entry.id : '',
      username,
      explicitSelection: false,
      createdAt: Date.now(),
    })
    return { ok: true, staged: true }
  }
  if (message.action === 'stage-credential') {
    const active = await unlockedSession()
    const page = await trustedCurrentPage(context, message.pageUrl)
    const capture = message.capture
    if (!capture || !['login', 'registration', 'password-change'].includes(capture.kind)) throw new Error('Unsupported credential capture.')
    const username = safeText(capture.username, 512)
    const password = safeSecret(capture.password)
    const currentPassword = safeSecret(capture.currentPassword)
    if (!password) throw new Error('No password was captured.')
    const matches = matchesForPage(active, page.href)
    const existing = matches.find(({ entry }) => capture.kind === 'password-change'
      ? (currentPassword && entry.password === currentPassword) || (username && entry.username === username)
      : username && entry.username === username)
    pendingCaptures.set(context.tabId, {
      kind: capture.kind,
      origin: page.origin,
      hostname: page.hostname,
      username,
      password,
      credentialId: existing?.entry.id || '',
      createdAt: Date.now(),
    })
    multiStepContexts.delete(context.tabId)
    clearFillAuthorizationsForTab(context.tabId)
    return { ok: true, staged: true }
  }
  if (message.action === 'page-ready') {
    const page = await trustedCurrentPage(context, message.pageUrl)
    const pending = pendingCaptures.get(context.tabId)
    if (!pending || pending.origin !== page.origin || Date.now() - pending.createdAt > 10 * 60_000) {
      if (pending) pendingCaptures.delete(context.tabId)
      return { ok: true, pending: null }
    }
    return { ok: true, pending: { kind: pending.kind, hostname: pending.hostname, username: pending.username } }
  }
  if (message.action === 'discard-pending') {
    pendingCaptures.delete(context.tabId)
    multiStepContexts.delete(context.tabId)
    return { ok: true }
  }
  if (message.action === 'save-pending') {
    const active = await unlockedSession()
    const page = await trustedCurrentPage(context, message.pageUrl)
    const pending = pendingCaptures.get(context.tabId)
    if (!pending || pending.origin !== page.origin || Date.now() - pending.createdAt > 10 * 60_000) throw new Error('That pending credential expired.')
    const now = new Date().toISOString()
    const historyLimit = sessionPreferences(active).passwordHistoryLimit
    let items
    if (pending.kind === 'password-change') {
      if (!pending.credentialId) throw new Error('Hush could not identify the existing credential, so it did not overwrite anything.')
      items = active.payload.items.map((entry) => entry.id === pending.credentialId ? {
        ...entry,
        passwordHistory: historyLimit > 0 ? [{ password: entry.password, changedAt: now }, ...(entry.passwordHistory || [])].slice(0, historyLimit) : [],
        password: pending.password,
        passwordChangedAt: now,
        updatedAt: now,
        revision: (entry.revision || 1) + 1,
        encryptionVersion: 2,
      } : entry)
    } else {
      const existing = pending.credentialId && active.payload.items.find((entry) => entry.id === pending.credentialId)
      if (existing) {
        items = active.payload.items.map((entry) => entry.id === existing.id ? {
          ...entry,
          username: pending.username || entry.username,
          passwordHistory: historyLimit > 0 && entry.password !== pending.password ? [{ password: entry.password, changedAt: now }, ...(entry.passwordHistory || [])].slice(0, historyLimit) : (entry.passwordHistory || []),
          password: pending.password,
          passwordChangedAt: now,
          updatedAt: now,
          revision: (entry.revision || 1) + 1,
        } : entry)
      } else {
        items = [{
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
        }, ...active.payload.items]
      }
    }
    await replaceSessionEnvelope({ ...active.payload, items })
    pendingCaptures.delete(context.tabId)
    multiStepContexts.delete(context.tabId)
    return { ok: true }
  }
  throw new Error('Unknown content-script action.')
}

async function handleExtensionMessage(message) {
  if (!actionAllowed('extension', message.action)) throw new Error('Unknown extension action.')
  if (message.action === 'status') {
    const envelope = await readStoredEnvelope()
    const active = await unlockedSession({ touch: false, allowMissing: true })
    return {
      ok: true,
      hasVault: Boolean(envelope),
      unlocked: Boolean(active),
      format: envelope?.format || '',
      itemCount: active?.payload?.items?.length || 0,
      preferences: active ? sessionPreferences(active) : null,
      externalArchiveWaiting: Boolean(await readPendingArchive()),
    }
  }
  if (message.action === 'unlock') {
    const envelope = await readStoredEnvelope()
    if (!envelope) throw new Error('Import or create an encrypted vault first.')
    const opened = await openEnvelope(safeSecret(message.password), envelope)
    if (opened.migrated) await storeEnvelope(opened.envelope)
    await storeUnlockedSession(opened)
    return { ok: true, itemCount: opened.payload.items.length, migrated: Boolean(opened.migrated), archive: serializeEnvelope(opened.envelope), payload: opened.payload }
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
      preferences: { autoLockMinutes: 15, clipboardClearSeconds: 30, passwordHistoryLimit: 5, autofillSingleExact: false },
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
  let nextOrigin = ''
  try { nextOrigin = new URL(changeInfo.url).origin } catch {}
  const multiStep = multiStepContexts.get(tabId)
  if (multiStep && multiStep.origin !== nextOrigin) multiStepContexts.delete(tabId)
  const pending = pendingCaptures.get(tabId)
  if (pending && pending.origin !== nextOrigin) pendingCaptures.delete(tabId)
})
chrome.tabs.onRemoved.addListener((tabId) => {
  clearFillAuthorizationsForTab(tabId)
  multiStepContexts.delete(tabId)
  pendingCaptures.delete(tabId)
})
