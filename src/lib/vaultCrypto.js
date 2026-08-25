const DB_NAME = 'hush-encrypted-vault'
const STORE_NAME = 'vaults'
const RECORD_KEY = 'primary'
const FORMAT = 'hush-vault-v1'
const ITERATIONS = 600_000
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const WRAP_AAD = encoder.encode(`${FORMAT}:wrapped-key`)
const PAYLOAD_AAD = encoder.encode(`${FORMAT}:payload`)

const randomBytes = (size) => crypto.getRandomValues(new Uint8Array(size))

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

async function deriveWrappingKey(password, salt, iterations = ITERATIONS) {
  const passwordMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    passwordMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function encryptPayload(dataKey, payload) {
  const iv = randomBytes(12)
  const plaintext = encoder.encode(JSON.stringify(payload))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: PAYLOAD_AAD, tagLength: 128 },
    dataKey,
    plaintext,
  )
  plaintext.fill(0)
  return { algorithm: 'AES-GCM', iv, ciphertext }
}

export async function readStoredVault() {
  return transact('readonly', (store) => store.get(RECORD_KEY))
}

export async function hasStoredVault() {
  return Boolean(await readStoredVault())
}

export async function createVault(password, payload) {
  if (await readStoredVault()) throw new Error('An encrypted vault already exists in this browser.')
  const salt = randomBytes(16)
  const wrappingKey = await deriveWrappingKey(password, salt)
  const rawDataKey = randomBytes(32)
  const dataKey = await crypto.subtle.importKey('raw', rawDataKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  const wrapIv = randomBytes(12)
  const wrappedCiphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: wrapIv, additionalData: WRAP_AAD, tagLength: 128 },
    wrappingKey,
    rawDataKey,
  )
  rawDataKey.fill(0)
  const envelope = {
    format: FORMAT,
    revision: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt },
    wrappedKey: { algorithm: 'AES-GCM', iv: wrapIv, ciphertext: wrappedCiphertext },
    payload: await encryptPayload(dataKey, payload),
  }
  await transact('readwrite', (store) => store.add(envelope, RECORD_KEY))
  return { dataKey, envelope }
}

export async function unlockVault(password) {
  const envelope = await readStoredVault()
  if (!envelope || envelope.format !== FORMAT) throw new Error('Unsupported or missing vault')
  try {
    const wrappingKey = await deriveWrappingKey(password, envelope.kdf.salt, envelope.kdf.iterations)
    const rawDataKey = new Uint8Array(await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: envelope.wrappedKey.iv,
        additionalData: WRAP_AAD,
        tagLength: 128,
      },
      wrappingKey,
      envelope.wrappedKey.ciphertext,
    ))
    const dataKey = await crypto.subtle.importKey('raw', rawDataKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
    rawDataKey.fill(0)
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: envelope.payload.iv,
        additionalData: PAYLOAD_AAD,
        tagLength: 128,
      },
      dataKey,
      envelope.payload.ciphertext,
    )
    const payload = JSON.parse(decoder.decode(plaintext))
    if (payload?.schemaVersion !== 1 || !Array.isArray(payload.items)) throw new Error('Invalid vault schema')
    return { dataKey, envelope, payload }
  } catch {
    throw new Error('Couldn’t unlock this vault.')
  }
}

export async function persistVault(dataKey, envelope, payload) {
  const expectedRevision = envelope.revision || 0
  const nextEnvelope = { ...envelope, revision: expectedRevision + 1, payload: await encryptPayload(dataKey, payload) }
  await replaceStoredVault(expectedRevision, nextEnvelope)
  return nextEnvelope
}

export async function deleteStoredVault() {
  return transact('readwrite', (store) => store.delete(RECORD_KEY))
}

export { FORMAT, ITERATIONS }
