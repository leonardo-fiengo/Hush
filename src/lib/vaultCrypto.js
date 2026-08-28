import {
  benchmarkArgon2id,
  changeMasterPasswordEnvelope,
  createVaultEnvelope,
  CURRENT_FORMAT,
  DEFAULT_ARGON2_PARAMS,
  LEGACY_FORMAT,
  LEGACY_PBKDF2_ITERATIONS,
  migrateLegacyVaultEnvelope,
  openCurrentVaultEnvelope,
  openVaultWithDataKey,
  persistVaultEnvelope,
  recoverAndRewrapVaultEnvelope,
} from './vaultCryptoCore.js'

const DB_NAME = 'hush-encrypted-vault'
const STORE_NAME = 'vaults'
const RECORD_KEY = 'primary'

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function transact(mode, operation) {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode)
    const store = transaction.objectStore(STORE_NAME)
    const request = operation(store)
    let result
    request.onsuccess = () => { result = request.result }
    transaction.oncomplete = () => {
      database.close()
      resolve(result)
    }
    transaction.onabort = () => {
      const error = transaction.error || request.error || new Error('The vault storage transaction was aborted.')
      database.close()
      reject(error)
    }
    transaction.onerror = () => {}
  })
}

async function replaceStoredVault(expectedRevision, nextEnvelope) {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.get(RECORD_KEY)
    let conflict = false
    request.onsuccess = () => {
      const currentRevision = request.result?.revision || 0
      if (currentRevision !== expectedRevision) {
        conflict = true
        transaction.abort()
        return
      }
      store.put(nextEnvelope, RECORD_KEY)
    }
    transaction.oncomplete = () => {
      database.close()
      resolve()
    }
    transaction.onabort = () => {
      database.close()
      reject(conflict
        ? new Error('This vault changed in another tab. Lock and unlock it before editing again.')
        : transaction.error || request.error || new Error('The vault storage transaction was aborted.'))
    }
    transaction.onerror = () => {}
  })
}

export async function readStoredVault() {
  return transact('readonly', (store) => store.get(RECORD_KEY))
}

export async function hasStoredVault() {
  return Boolean(await readStoredVault())
}

export async function createVault(password, payload, options) {
  if (await readStoredVault()) throw new Error('An encrypted vault already exists in this browser.')
  const created = await createVaultEnvelope(password, payload, options)
  await transact('readwrite', (store) => store.add(created.envelope, RECORD_KEY))
  return created
}

export async function unlockVaultEnvelope(password, envelope) {
  if (envelope?.format === LEGACY_FORMAT) return migrateLegacyVaultEnvelope(password, envelope)
  return openCurrentVaultEnvelope(password, envelope)
}

export async function unlockVault(password) {
  const stored = await readStoredVault()
  const opened = await unlockVaultEnvelope(password, stored)
  if (opened.migrated) await replaceStoredVault(stored.revision || 0, opened.envelope)
  return opened
}

export async function persistVault(dataKey, envelope, payload) {
  const nextEnvelope = await persistVaultEnvelope(dataKey, envelope, payload)
  await replaceStoredVault(envelope.revision || 0, nextEnvelope)
  return nextEnvelope
}

export async function openVaultEnvelope(dataKey, envelope) {
  if (!dataKey || envelope?.format !== CURRENT_FORMAT) throw new Error('Unsupported or missing vault.')
  try {
    return await openVaultWithDataKey(dataKey, envelope)
  } catch {
    throw new Error('The linked device sent a vault that could not be authenticated.')
  }
}

export async function changeMasterPassword(oldPassword, newPassword, envelope = null) {
  const stored = envelope || await readStoredVault()
  const changed = await changeMasterPasswordEnvelope(stored, oldPassword, newPassword)
  await replaceStoredVault(stored.revision || 0, changed.envelope)
  return changed
}

export async function recoverVault(recoveryKey, newPassword, envelope = null) {
  const stored = envelope || await readStoredVault()
  const recovered = await recoverAndRewrapVaultEnvelope(stored, recoveryKey, newPassword)
  await replaceStoredVault(stored.revision || 0, recovered.envelope)
  return recovered
}

export async function installTransferredVault(envelope) {
  if (![CURRENT_FORMAT, LEGACY_FORMAT].includes(envelope?.format)) throw new Error('Unsupported or missing vault.')
  await transact('readwrite', (store) => store.add(envelope, RECORD_KEY))
}

export async function applyTransferredVault(expectedRevision, envelope) {
  if (envelope?.format !== CURRENT_FORMAT) throw new Error('Unsupported or missing vault.')
  await replaceStoredVault(expectedRevision, envelope)
}

export async function restoreVaultArchive(envelope, { replace = false } = {}) {
  if (![CURRENT_FORMAT, LEGACY_FORMAT].includes(envelope?.format)) throw new Error('Unsupported or missing vault.')
  const current = await readStoredVault()
  if (current && !replace) throw new Error('A local vault already exists. Confirm replacement before restoring.')
  if (current) await replaceStoredVault(current.revision || 0, envelope)
  else await transact('readwrite', (store) => store.add(envelope, RECORD_KEY))
  return envelope
}

export async function deleteStoredVault() {
  return transact('readwrite', (store) => store.delete(RECORD_KEY))
}

export {
  benchmarkArgon2id,
  CURRENT_FORMAT as FORMAT,
  DEFAULT_ARGON2_PARAMS as ARGON2_PARAMS,
  LEGACY_PBKDF2_ITERATIONS as ITERATIONS,
}
