import {
  createVaultEnvelope,
  LEGACY_FORMAT,
  migrateLegacyVaultEnvelope,
  openCurrentVaultEnvelope,
  persistVaultEnvelope,
} from '../../src/lib/vaultCryptoCore.js'
import { generatePassword } from '../../src/lib/passwordGenerator.js'
import { masterPasswordHealth } from '../../src/lib/passwordRisk.js'
import { deserializeEnvelope, serializeEnvelope } from '../../src/lib/vaultTransfer.js'
import { credentialsForPage } from './domainMatch.js'
import { actionAllowed, classifyMessageSender } from './messagePolicy.js'

const STORAGE_KEY = 'encryptedVaultArchive'
const HUSH_WEB_ORIGINS = new Set(['https://hush-password-manager.vercel.app'])
const MAX_ARCHIVE_CHARACTERS = 70_000_000
const MAX_SECRET_LENGTH = 4096

let session = null
let externalArchive = null
const pendingCaptures = new Map()

function extensionOrigin() {
  return chrome.runtime.getURL('/')
}

function senderContext(sender) {
  return classifyMessageSender(sender, { extensionId: chrome.runtime.id, extensionOrigin: extensionOrigin() })
}

async function readStoredEnvelope() {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  if (!stored[STORAGE_KEY]) return null
  return deserializeEnvelope(stored[STORAGE_KEY])
}

async function storeEnvelope(envelope) {
  await chrome.storage.local.set({ [STORAGE_KEY]: serializeEnvelope(envelope) })
}

function clearSession() {
  session = null
  pendingCaptures.clear()
}

function sessionPreferences() {
  return {
    autoLockMinutes: Number(session?.payload?.preferences?.autoLockMinutes ?? 15),
    clipboardClearSeconds: Number(session?.payload?.preferences?.clipboardClearSeconds ?? 30),
    passwordHistoryLimit: Number(session?.payload?.preferences?.passwordHistoryLimit ?? 5),
  }
}

function unlockedSession() {
  if (!session) throw new Error('Unlock Hush from the extension first.')
  const autoLockMinutes = sessionPreferences().autoLockMinutes
  if (autoLockMinutes > 0 && Date.now() - session.lastActiveAt >= autoLockMinutes * 60_000) {
    clearSession()
    throw new Error('Hush locked after inactivity. Unlock it again.')
  }
  session.lastActiveAt = Date.now()
  return session
}

async function openEnvelope(password, envelope) {
  return envelope?.format === LEGACY_FORMAT
    ? migrateLegacyVaultEnvelope(password, envelope)
    : openCurrentVaultEnvelope(password, envelope)
}

async function replaceSessionEnvelope(payload) {
  const active = unlockedSession()
  const nextEnvelope = await persistVaultEnvelope(active.dataKey, active.envelope, payload)
  await storeEnvelope(nextEnvelope)
  session = { ...active, envelope: nextEnvelope, payload, lastActiveAt: Date.now() }
  return session
}

function safeText(value, maxLength) {
  return String(value || '').normalize('NFKC').slice(0, maxLength)
}

function safeSecret(value, maxLength = MAX_SECRET_LENGTH) {
  return String(value || '').slice(0, maxLength)
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
    const active = unlockedSession()
    return { ok: true, credentials: matchesForSender(active, context).map(({ entry, match }) => credentialSummary(entry, match)) }
  }
  if (message.action === 'fill-credential') {
    const active = unlockedSession()
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
    unlockedSession()
    return { ok: true, password: generatePassword() }
  }
  if (message.action === 'stage-credential') {
    const active = unlockedSession()
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
    const active = unlockedSession()
    const pending = pendingCaptures.get(context.tabId)
    if (!pending || pending.origin !== context.url.origin || Date.now() - pending.createdAt > 10 * 60_000) throw new Error('That pending credential expired.')
    const now = new Date().toISOString()
    const historyLimit = sessionPreferences().passwordHistoryLimit
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
    return { ok: true, hasVault: Boolean(envelope), unlocked: Boolean(session), format: envelope?.format || '', itemCount: session?.payload?.items?.length || 0, preferences: session ? sessionPreferences() : null, externalArchiveWaiting: Boolean(externalArchive) }
  }
  if (message.action === 'unlock') {
    const envelope = await readStoredEnvelope()
    if (!envelope) throw new Error('Import or create an encrypted vault first.')
    const opened = await openEnvelope(safeSecret(message.password), envelope)
    if (opened.migrated) await storeEnvelope(opened.envelope)
    session = { dataKey: opened.dataKey, envelope: opened.envelope, payload: opened.payload, lastActiveAt: Date.now() }
    return { ok: true, itemCount: opened.payload.items.length, migrated: Boolean(opened.migrated) }
  }
  if (message.action === 'lock') {
    clearSession()
    return { ok: true }
  }
  if (message.action === 'create-vault') {
    if (await readStoredEnvelope()) throw new Error('An encrypted extension vault already exists.')
    const password = safeSecret(message.password)
    if (!masterPasswordHealth(password).acceptable) throw new Error('Choose a longer, less predictable master password.')
    const created = await createVaultEnvelope(password, {
      schemaVersion: 2,
      items: [],
      preferences: { autoLockMinutes: 15, clipboardClearSeconds: 30, passwordHistoryLimit: 5 },
    })
    await storeEnvelope(created.envelope)
    session = { dataKey: created.dataKey, envelope: created.envelope, payload: created.payload, lastActiveAt: Date.now() }
    return { ok: true, recoveryKey: created.recoveryKey }
  }
  if (message.action === 'import-vault') {
    const archive = String(message.archive || externalArchive || '').slice(0, MAX_ARCHIVE_CHARACTERS)
    if (!archive) throw new Error('Choose a Hush backup first.')
    const envelope = deserializeEnvelope(archive)
    const opened = await openEnvelope(safeSecret(message.password), envelope)
    await storeEnvelope(opened.envelope)
    externalArchive = null
    await chrome.action.setBadgeText({ text: '' })
    session = { dataKey: opened.dataKey, envelope: opened.envelope, payload: opened.payload, lastActiveAt: Date.now() }
    return { ok: true, itemCount: opened.payload.items.length }
  }
  if (message.action === 'export-vault') {
    const envelope = await readStoredEnvelope()
    if (!envelope) throw new Error('There is no encrypted vault to export.')
    return { ok: true, archive: serializeEnvelope(envelope, 2) }
  }
  if (message.action === 'update-settings') {
    const active = unlockedSession()
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

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  let origin = ''
  try { origin = new URL(sender.url).origin } catch {}
  if (!HUSH_WEB_ORIGINS.has(origin) || message?.action !== 'stage-encrypted-vault' || typeof message.archive !== 'string' || message.archive.length > MAX_ARCHIVE_CHARACTERS) {
    sendResponse({ ok: false, error: 'Untrusted external request.' })
    return false
  }
  try {
    deserializeEnvelope(message.archive)
    externalArchive = message.archive
    chrome.action.setBadgeBackgroundColor({ color: '#60701f' })
    chrome.action.setBadgeText({ text: '1' })
    sendResponse({ ok: true, staged: true })
  } catch (error) {
    sendResponse({ ok: false, error: error.message })
  }
  return false
})

chrome.idle.onStateChanged.addListener((state) => {
  if (state === 'idle' || state === 'locked') clearSession()
})
chrome.idle.setDetectionInterval(60)
chrome.runtime.onSuspend.addListener(clearSession)
chrome.permissions.onRemoved.addListener(async ({ origins = [] }) => {
  for (const pattern of origins) {
    const id = scriptIdForPattern(pattern)
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] })
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [id] })
  }
})
