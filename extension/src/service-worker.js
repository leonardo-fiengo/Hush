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

const pendingCaptures = new Map()

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
}

function sessionPreferences(active) {
  return {
    autoLockMinutes: normalizeAutoLockMinutes(active?.payload?.preferences?.autoLockMinutes),
    clipboardClearSeconds: Number(active?.payload?.preferences?.clipboardClearSeconds ?? 30),
    passwordHistoryLimit: Number(active?.payload?.preferences?.passwordHistoryLimit ?? 5),
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

function credentialSummary(entry, match) {
  return {
    id: entry.id,
    name: safeText(entry.name, 160),
    username: safeText(entry.username, 512),
    hostname: match.page.hostname,
    fillable: Boolean(match.fillable),
    warning: match.fillable ? (match.requiresConfirmation ? match.reason : '') : match.reason,
  }
}

function matchesForSender(active, context) {
  return credentialsForPage(active.payload.items || [], context.url.href)
}

async function handleContentMessage(message, context) {
  if (!actionAllowed('content', message.action)) throw new Error('Unknown or disallowed content-script action.')
  if (message.action === 'request-credentials') {
    const active = await unlockedSession()
    return { ok: true, credentials: matchesForSender(active, context).map(({ entry, match }) => credentialSummary(entry, match)) }
  }
  if (message.action === 'fill-credential') {
    const active = await unlockedSession()
    if (typeof message.credentialId !== 'string' || message.credentialId.length > 200) throw new Error('Invalid credential selection.')
    const candidate = matchesForSender(active, context).find(({ entry }) => entry.id === message.credentialId)
    if (!candidate || !candidate.match.fillable) throw new Error(candidate?.match.reason || 'That credential does not exactly match this page.')
    const currentTab = await chrome.tabs.get(context.tabId)
    if (!currentTab?.url || new URL(currentTab.url).origin !== context.url.origin) throw new Error('The page changed before Hush could fill it.')
    await chrome.tabs.sendMessage(context.tabId, {
      action: 'perform-fill',
      credential: {
        username: candidate.entry.username || '',
        password: candidate.entry.password,
      },
    }, { frameId: 0 })
    return { ok: true }
  }
  if (message.action === 'generate-password') {
    await unlockedSession()
    return { ok: true, password: generatePassword() }
  }
  if (message.action === 'stage-credential') {
    const active = await unlockedSession()
    const capture = message.capture
    if (!capture || !['login', 'registration', 'password-change'].includes(capture.kind)) throw new Error('Unsupported credential capture.')
    const username = safeText(capture.username, 512)
    const password = safeSecret(capture.password)
    const currentPassword = safeSecret(capture.currentPassword)
    if (!password) throw new Error('No password was captured.')
    const matches = matchesForSender(active, context)
    const existing = matches.find(({ entry }) => capture.kind === 'password-change'
      ? (currentPassword && entry.password === currentPassword) || (username && entry.username === username)
      : username && entry.username === username)
    pendingCaptures.set(context.tabId, {
      kind: capture.kind,
      origin: context.url.origin,
      hostname: context.url.hostname,
      username,
      password,
      credentialId: existing?.entry.id || '',
      createdAt: Date.now(),
    })
    return { ok: true, staged: true }
  }
  if (message.action === 'page-ready') {
    const pending = pendingCaptures.get(context.tabId)
    if (!pending || pending.origin !== context.url.origin || Date.now() - pending.createdAt > 10 * 60_000) return { ok: true, pending: null }
    return { ok: true, pending: { kind: pending.kind, hostname: pending.hostname, username: pending.username } }
  }
  if (message.action === 'discard-pending') {
    pendingCaptures.delete(context.tabId)
    return { ok: true }
  }
  if (message.action === 'save-pending') {
    const active = await unlockedSession()
    const pending = pendingCaptures.get(context.tabId)
    if (!pending || pending.origin !== context.url.origin || Date.now() - pending.createdAt > 10 * 60_000) throw new Error('That pending credential expired.')
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
    return { ok: true }
  }
  throw new Error('Unknown content-script action.')
}

function sitePattern(urlValue) {
  const url = new URL(urlValue)
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Hush can only run on normal web pages.')
  return `${url.protocol}//${url.hostname}/*`
}

function scriptIdForPattern(pattern) {
  return `hush_${pattern.replace(/[^a-z0-9]/giu, '_').slice(0, 200)}`
}

async function registerPattern(pattern) {
  const id = scriptIdForPattern(pattern)
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] })
  if (!existing.length) await chrome.scripting.registerContentScripts([{
    id,
    matches: [pattern],
    js: ['content.js'],
    runAt: 'document_idle',
    allFrames: false,
    persistAcrossSessions: true,
  }])
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
      preferences: { autoLockMinutes: 15, clipboardClearSeconds: 30, passwordHistoryLimit: 5 },
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
    await replaceSessionEnvelope({ ...active.payload, preferences })
    return { ok: true, preferences }
  }
  if (message.action === 'register-site') {
    const tab = await chrome.tabs.get(Number(message.tabId))
    if (!tab?.id || !tab.url || new URL(tab.url).origin !== new URL(message.url).origin) throw new Error('The active site changed before Hush could be enabled.')
    const pattern = sitePattern(tab.url)
    const allowed = await chrome.permissions.contains({ origins: [pattern] })
    if (!allowed) throw new Error('Site access was not granted.')
    await registerPattern(pattern)
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['content.js'] })
    return { ok: true, pattern }
  }
  if (message.action === 'list-sites') {
    const permissions = await chrome.permissions.getAll()
    return { ok: true, origins: (permissions.origins || []).sort() }
  }
  if (message.action === 'remove-site') {
    const pattern = safeText(message.pattern, 500)
    const removed = await chrome.permissions.remove({ origins: [pattern] })
    const id = scriptIdForPattern(pattern)
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] })
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [id] })
    return { ok: true, removed }
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
chrome.permissions.onRemoved.addListener(async ({ origins = [] }) => {
  for (const pattern of origins) {
    const id = scriptIdForPattern(pattern)
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] })
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [id] })
  }
})
