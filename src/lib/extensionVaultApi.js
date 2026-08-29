import { deserializeEnvelope, serializeEnvelope } from './vaultTransfer.js'

const SESSION_HANDLE = Object.freeze({ extensionSession: true })

function runtimeMessage(payload) {
  return new Promise((resolve) => chrome.runtime.sendMessage(payload, (response) => {
    if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message })
    else resolve(response || { ok: false, error: 'The Hush extension did not respond.' })
  }))
}

async function request(action, fields = {}) {
  const response = await runtimeMessage({ action, ...fields })
  if (!response.ok) throw new Error(response.error || 'The Hush extension rejected that request.')
  return response
}

function openedResult(response) {
  return {
    dataKey: SESSION_HANDLE,
    envelope: deserializeEnvelope(response.archive),
    payload: response.payload,
    migrated: Boolean(response.migrated),
    recoveryKey: response.recoveryKey || null,
  }
}

export const extensionVaultApi = Object.freeze({
  mode: 'extension',

  async status() {
    return request('status')
  },

  async hasStoredVault() {
    return Boolean((await request('status')).hasVault)
  },

  async resumeVault() {
    const status = await request('status')
    if (!status.unlocked) return null
    return openedResult(await request('resume-vault'))
  },

  async touchSession() {
    return request('touch-session')
  },

  async readStoredVault() {
    const response = await request('read-envelope')
    return response.archive ? deserializeEnvelope(response.archive) : null
  },

  async createVault(password, payload) {
    return openedResult(await request('create-vault', { password, payload }))
  },

  async unlockVault(password) {
    return openedResult(await request('unlock', { password }))
  },

  async unlockVaultEnvelope(password, envelope) {
    return openedResult(await request('authenticate-envelope', { password, archive: serializeEnvelope(envelope) }))
  },

  async installTransferredVault(envelope) {
    return request('install-envelope', { archive: serializeEnvelope(envelope) })
  },

  async openVaultEnvelope(_sessionHandle, envelope) {
    return (await request('open-with-session', { archive: serializeEnvelope(envelope) })).payload
  },

  async applyTransferredVault(expectedRevision, envelope) {
    return request('apply-envelope', { expectedRevision, archive: serializeEnvelope(envelope) })
  },

  async persistVault(_sessionHandle, envelope, payload) {
    return deserializeEnvelope((await request('replace-payload', { expectedRevision: envelope.revision, payload })).archive)
  },

  async changeMasterPassword(currentPassword, nextPassword) {
    return openedResult(await request('change-master-password', { currentPassword, nextPassword }))
  },

  async recoverVault(recoveryKey, nextPassword) {
    return openedResult(await request('recover-vault', { recoveryKey, nextPassword }))
  },

  async restoreVaultArchive(envelope, { replace = false } = {}) {
    return deserializeEnvelope((await request('restore-envelope', { archive: serializeEnvelope(envelope), replace })).archive)
  },

  async deleteStoredVault() {
    await request('delete-vault')
  },

  async lockVault() {
    await request('lock')
  },
})
