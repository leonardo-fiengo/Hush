import { argon2id } from 'hash-wasm'

export const CURRENT_FORMAT = 'hush-vault-v2'
export const LEGACY_FORMAT = 'hush-vault-v1'
export const ENCRYPTION_VERSION = 2
export const PAYLOAD_SCHEMA_VERSION = 2
const MIN_ARGON2_MEMORY_KIB = 19 * 1024
const MIN_ARGON2_ITERATIONS = 2
export const DEFAULT_ARGON2_PARAMS = Object.freeze({
  name: 'Argon2id',
  version: 19,
  memorySize: 64 * 1024,
  iterations: 3,
  parallelism: 1,
  hashLength: 32,
})
export const LEGACY_PBKDF2_ITERATIONS = 600_000

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const EMPTY_BYTES = new Uint8Array(0)
const MAX_ARGON2_MEMORY_KIB = 256 * 1024
const MAX_ARGON2_ITERATIONS = 10
const BASE32_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function randomBytes(size) {
  if (!Number.isInteger(size) || size < 1 || size > 65_536) throw new Error('Invalid random byte request.')
  return crypto.getRandomValues(new Uint8Array(size))
}

function toBytes(value, label = 'encrypted byte field') {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw new Error(`Invalid ${label}.`)
}

function bytesToBase64(value) {
  const bytes = toBytes(value)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function base64ToBytes(value, label = 'base64 value') {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new Error(`Invalid ${label}.`)
  }
  let binary
  try {
    binary = atob(value)
  } catch {
    throw new Error(`Invalid ${label}.`)
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function normalizePassword(password) {
  if (typeof password !== 'string' || !password) throw new Error('A master password is required.')
  return password.normalize('NFKC')
}

function validateArgon2Params(kdf) {
  const params = {
    name: kdf?.name,
    version: Number(kdf?.version),
    memorySize: Number(kdf?.memorySize),
    iterations: Number(kdf?.iterations),
    parallelism: Number(kdf?.parallelism),
    hashLength: Number(kdf?.hashLength),
  }
  if (
    params.name !== 'Argon2id'
    || params.version !== 19
    || !Number.isInteger(params.memorySize)
    || params.memorySize < MIN_ARGON2_MEMORY_KIB
    || params.memorySize > MAX_ARGON2_MEMORY_KIB
    || !Number.isInteger(params.iterations)
    || params.iterations < MIN_ARGON2_ITERATIONS
    || params.iterations > MAX_ARGON2_ITERATIONS
    || !Number.isInteger(params.parallelism)
    || params.parallelism < 1
    || params.parallelism > 4
    || params.hashLength !== 32
  ) throw new Error('Unsupported Argon2id parameters.')
  return params
}

function wrappingAad(format, kdf) {
  return encoder.encode(JSON.stringify({
    purpose: 'hush-vault-key-wrap',
    format,
    kdf: {
      name: kdf.name,
      version: kdf.version,
      memorySize: kdf.memorySize,
      iterations: kdf.iterations,
      parallelism: kdf.parallelism,
      hashLength: kdf.hashLength,
      salt: bytesToBase64(kdf.salt),
    },
  }))
}

function recoveryAad(envelope, recovery) {
  return encoder.encode(JSON.stringify({
    purpose: 'hush-recovery-key-wrap',
    format: envelope.format,
    vaultId: envelope.vaultId,
    kdf: {
      name: recovery.kdf.name,
      hash: recovery.kdf.hash,
      salt: bytesToBase64(recovery.kdf.salt),
    },
  }))
}

function payloadAad(envelope) {
  return encoder.encode(JSON.stringify({
    purpose: 'hush-vault-payload',
    format: envelope.format,
    encryptionVersion: envelope.encryptionVersion,
    vaultId: envelope.vaultId,
    schemaVersion: PAYLOAD_SCHEMA_VERSION,
  }))
}

function authenticatedMetadata(envelope) {
  const recovery = envelope.recovery
    ? {
        kdf: {
          name: envelope.recovery.kdf.name,
          hash: envelope.recovery.kdf.hash,
          salt: bytesToBase64(envelope.recovery.kdf.salt),
        },
        wrappedKey: {
          algorithm: envelope.recovery.wrappedKey.algorithm,
          iv: bytesToBase64(envelope.recovery.wrappedKey.iv),
          ciphertext: bytesToBase64(envelope.recovery.wrappedKey.ciphertext),
        },
      }
    : null
  return encoder.encode(JSON.stringify({
    purpose: 'hush-envelope-metadata',
    format: envelope.format,
    encryptionVersion: envelope.encryptionVersion,
    vaultId: envelope.vaultId,
    revision: envelope.revision,
    sync: envelope.sync,
    kdf: {
      name: envelope.kdf.name,
      version: envelope.kdf.version,
      memorySize: envelope.kdf.memorySize,
      iterations: envelope.kdf.iterations,
      parallelism: envelope.kdf.parallelism,
      hashLength: envelope.kdf.hashLength,
      salt: bytesToBase64(envelope.kdf.salt),
    },
    wrappedKey: {
      algorithm: envelope.wrappedKey.algorithm,
      iv: bytesToBase64(envelope.wrappedKey.iv),
      ciphertext: bytesToBase64(envelope.wrappedKey.ciphertext),
    },
    payload: {
      algorithm: envelope.payload.algorithm,
      schemaVersion: envelope.payload.schemaVersion,
      iv: bytesToBase64(envelope.payload.iv),
      ciphertext: bytesToBase64(envelope.payload.ciphertext),
    },
    recovery,
  }))
}

function syncMetadata() {
  return { changeId: crypto.randomUUID(), changedAt: new Date().toISOString() }
}

async function importDataKey(rawDataKey) {
  return crypto.subtle.importKey('raw', rawDataKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export async function importSessionDataKey(sessionKeyMaterial) {
  let rawDataKey
  try {
    rawDataKey = base64ToBytes(sessionKeyMaterial, 'session vault key')
    if (rawDataKey.length !== 32) throw new Error('Invalid session vault key.')
    return await importDataKey(rawDataKey)
  } finally {
    rawDataKey?.fill(0)
  }
}

async function deriveArgon2WrappingKey(password, kdf) {
  const params = validateArgon2Params(kdf)
  const passwordBytes = encoder.encode(normalizePassword(password))
  let rawKey
  try {
    rawKey = toBytes(await argon2id({
      password: passwordBytes,
      salt: toBytes(kdf.salt, 'Argon2id salt'),
      parallelism: params.parallelism,
      iterations: params.iterations,
      memorySize: params.memorySize,
      hashLength: params.hashLength,
      outputType: 'binary',
    }))
    return await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  } finally {
    passwordBytes.fill(0)
    rawKey?.fill(0)
  }
}

async function deriveLegacyWrappingKey(password, salt, iterations = LEGACY_PBKDF2_ITERATIONS) {
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 10_000_000) throw new Error('Unsupported PBKDF2 parameters.')
  const passwordBytes = encoder.encode(normalizePassword(password))
  try {
    const passwordMaterial = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey'])
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: toBytes(salt, 'PBKDF2 salt'), iterations, hash: 'SHA-256' },
      passwordMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  } finally {
    passwordBytes.fill(0)
  }
}

async function wrapDataKey(rawDataKey, password, kdf) {
  const wrappingKey = await deriveArgon2WrappingKey(password, kdf)
  const iv = randomBytes(12)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: wrappingAad(CURRENT_FORMAT, kdf), tagLength: 128 },
    wrappingKey,
    rawDataKey,
  )
  return { algorithm: 'AES-256-GCM', iv, ciphertext }
}

async function unwrapDataKey(password, envelope) {
  const wrappingKey = await deriveArgon2WrappingKey(password, envelope.kdf)
  return new Uint8Array(await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toBytes(envelope.wrappedKey.iv, 'vault-key IV'),
      additionalData: wrappingAad(envelope.format, envelope.kdf),
      tagLength: 128,
    },
    wrappingKey,
    toBytes(envelope.wrappedKey.ciphertext, 'wrapped vault key'),
  ))
}

function encodeRecoveryKey(bytes) {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return `HUSH-${output.match(/.{1,4}/gu).join('-')}`
}

function decodeRecoveryKey(value) {
  const compact = String(value || '').trim().toUpperCase().replace(/^HUSH-/u, '').replaceAll('-', '').replaceAll(' ', '')
  if (compact.length !== 52 || [...compact].some((character) => !BASE32_ALPHABET.includes(character))) {
    throw new Error('That recovery key is not valid.')
  }
  let bits = 0
  let buffer = 0
  const output = []
  for (const character of compact) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(character)
    bits += 5
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  if (output.length !== 32) throw new Error('That recovery key is not valid.')
  return new Uint8Array(output)
}

async function deriveRecoveryWrappingKey(recoveryKeyBytes, recoveryKdf) {
  if (recoveryKdf?.name !== 'HKDF' || recoveryKdf?.hash !== 'SHA-256') throw new Error('Unsupported recovery-key format.')
  const keyMaterial = await crypto.subtle.importKey('raw', recoveryKeyBytes, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toBytes(recoveryKdf.salt, 'recovery salt'),
      info: encoder.encode('Hush recovery key v1'),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function createRecoveryWrap(rawDataKey, envelope) {
  const recoveryKeyBytes = randomBytes(32)
  const recovery = {
    kdf: { name: 'HKDF', hash: 'SHA-256', salt: randomBytes(16) },
    wrappedKey: null,
  }
  try {
    const wrappingKey = await deriveRecoveryWrappingKey(recoveryKeyBytes, recovery.kdf)
    const iv = randomBytes(12)
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: recoveryAad(envelope, recovery), tagLength: 128 },
      wrappingKey,
      rawDataKey,
    )
    recovery.wrappedKey = { algorithm: 'AES-256-GCM', iv, ciphertext }
    return { recovery, recoveryKey: encodeRecoveryKey(recoveryKeyBytes) }
  } finally {
    recoveryKeyBytes.fill(0)
  }
}

async function unwrapRecoveryDataKey(recoveryKey, envelope) {
  if (!envelope.recovery) throw new Error('This vault does not have a recovery key.')
  const recoveryKeyBytes = decodeRecoveryKey(recoveryKey)
  try {
    const wrappingKey = await deriveRecoveryWrappingKey(recoveryKeyBytes, envelope.recovery.kdf)
    return new Uint8Array(await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toBytes(envelope.recovery.wrappedKey.iv, 'recovery IV'),
        additionalData: recoveryAad(envelope, envelope.recovery),
        tagLength: 128,
      },
      wrappingKey,
      toBytes(envelope.recovery.wrappedKey.ciphertext, 'recovery-wrapped vault key'),
    ))
  } catch {
    throw new Error('That recovery key could not unlock this vault.')
  } finally {
    recoveryKeyBytes.fill(0)
  }
}

async function encryptPayload(dataKey, envelope, payload) {
  const iv = randomBytes(12)
  const normalizedPayload = {
    ...payload,
    schemaVersion: PAYLOAD_SCHEMA_VERSION,
    items: Array.isArray(payload?.items) ? payload.items : [],
  }
  const plaintext = encoder.encode(JSON.stringify(normalizedPayload))
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: payloadAad(envelope), tagLength: 128 },
      dataKey,
      plaintext,
    )
    return { algorithm: 'AES-256-GCM', schemaVersion: PAYLOAD_SCHEMA_VERSION, iv, ciphertext }
  } finally {
    plaintext.fill(0)
  }
}

async function decryptPayload(dataKey, envelope) {
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toBytes(envelope.payload.iv, 'payload IV'),
      additionalData: payloadAad(envelope),
      tagLength: 128,
    },
    dataKey,
    toBytes(envelope.payload.ciphertext, 'vault ciphertext'),
  ))
  try {
    const payload = JSON.parse(decoder.decode(plaintext))
    if (payload?.schemaVersion !== PAYLOAD_SCHEMA_VERSION || !Array.isArray(payload.items)) throw new Error('Invalid vault schema.')
    return payload
  } finally {
    plaintext.fill(0)
  }
}

async function createIntegrityRecord(dataKey, envelope) {
  const iv = randomBytes(12)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: authenticatedMetadata(envelope), tagLength: 128 },
    dataKey,
    EMPTY_BYTES,
  )
  return { algorithm: 'AES-256-GCM', iv, ciphertext }
}

async function verifyIntegrity(dataKey, envelope) {
  await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toBytes(envelope.integrity?.iv, 'metadata IV'),
      additionalData: authenticatedMetadata(envelope),
      tagLength: 128,
    },
    dataKey,
    toBytes(envelope.integrity?.ciphertext, 'metadata authentication tag'),
  )
}

function validateCurrentEnvelope(envelope) {
  if (
    !envelope
    || envelope.format !== CURRENT_FORMAT
    || envelope.encryptionVersion !== ENCRYPTION_VERSION
    || typeof envelope.vaultId !== 'string'
    || envelope.vaultId.length < 16
    || !Number.isInteger(envelope.revision)
    || envelope.revision < 1
    || !envelope.kdf
    || !envelope.wrappedKey
    || !envelope.payload
    || !envelope.integrity
  ) throw new Error('Unsupported or incomplete vault.')
  validateArgon2Params(envelope.kdf)
}

export async function createVaultEnvelope(password, payload, options = {}) {
  const kdf = { ...DEFAULT_ARGON2_PARAMS, ...(options.kdf || {}), salt: randomBytes(16) }
  validateArgon2Params(kdf)
  const rawDataKey = randomBytes(32)
  try {
    const envelope = {
      format: CURRENT_FORMAT,
      encryptionVersion: ENCRYPTION_VERSION,
      vaultId: crypto.randomUUID(),
      revision: 1,
      sync: syncMetadata(),
      kdf,
      wrappedKey: await wrapDataKey(rawDataKey, password, kdf),
    }
    const recoveryResult = options.recovery === false ? null : await createRecoveryWrap(rawDataKey, envelope)
    envelope.recovery = recoveryResult?.recovery || null
    const dataKey = await importDataKey(rawDataKey)
    envelope.payload = await encryptPayload(dataKey, envelope, payload)
    envelope.integrity = await createIntegrityRecord(dataKey, envelope)
    return {
      dataKey,
      envelope,
      recoveryKey: recoveryResult?.recoveryKey || null,
      payload: { ...payload, schemaVersion: PAYLOAD_SCHEMA_VERSION },
      ...(options.includeSessionKeyMaterial ? { sessionKeyMaterial: bytesToBase64(rawDataKey) } : {}),
    }
  } finally {
    rawDataKey.fill(0)
  }
}

export async function openCurrentVaultEnvelope(password, envelope, options = {}) {
  validateCurrentEnvelope(envelope)
  let rawDataKey
  try {
    rawDataKey = await unwrapDataKey(password, envelope)
    if (rawDataKey.length !== 32) throw new Error('Invalid vault key.')
    const dataKey = await importDataKey(rawDataKey)
    await verifyIntegrity(dataKey, envelope)
    const payload = await decryptPayload(dataKey, envelope)
    return {
      dataKey,
      envelope,
      payload,
      ...(options.includeSessionKeyMaterial ? { sessionKeyMaterial: bytesToBase64(rawDataKey) } : {}),
    }
  } catch {
    throw new Error('Couldn’t unlock this vault.')
  } finally {
    rawDataKey?.fill(0)
  }
}

export async function persistVaultEnvelope(dataKey, envelope, payload) {
  validateCurrentEnvelope(envelope)
  if (!dataKey) throw new Error('The vault is locked.')
  const nextEnvelope = {
    ...envelope,
    revision: envelope.revision + 1,
    sync: syncMetadata(),
    payload: undefined,
    integrity: undefined,
  }
  nextEnvelope.payload = await encryptPayload(dataKey, nextEnvelope, payload)
  nextEnvelope.integrity = await createIntegrityRecord(dataKey, nextEnvelope)
  return nextEnvelope
}

export async function openVaultWithDataKey(dataKey, envelope) {
  validateCurrentEnvelope(envelope)
  await verifyIntegrity(dataKey, envelope)
  return decryptPayload(dataKey, envelope)
}

export async function changeMasterPasswordEnvelope(envelope, oldPassword, newPassword) {
  validateCurrentEnvelope(envelope)
  let rawDataKey
  try {
    rawDataKey = await unwrapDataKey(oldPassword, envelope)
    const dataKey = await importDataKey(rawDataKey)
    await verifyIntegrity(dataKey, envelope)
    const kdf = { ...DEFAULT_ARGON2_PARAMS, salt: randomBytes(16) }
    const nextEnvelope = {
      ...envelope,
      revision: envelope.revision + 1,
      sync: syncMetadata(),
      kdf,
      wrappedKey: await wrapDataKey(rawDataKey, newPassword, kdf),
      integrity: undefined,
    }
    nextEnvelope.integrity = await createIntegrityRecord(dataKey, nextEnvelope)
    return { dataKey, envelope: nextEnvelope, payload: await decryptPayload(dataKey, nextEnvelope) }
  } catch (error) {
    if (error?.message?.startsWith('Unsupported')) throw error
    throw new Error('Couldn’t change the master password. Check the current password.')
  } finally {
    rawDataKey?.fill(0)
  }
}

export async function recoverAndRewrapVaultEnvelope(envelope, recoveryKey, newPassword, options = {}) {
  validateCurrentEnvelope(envelope)
  let rawDataKey
  try {
    rawDataKey = await unwrapRecoveryDataKey(recoveryKey, envelope)
    const dataKey = await importDataKey(rawDataKey)
    await verifyIntegrity(dataKey, envelope)
    const payload = await decryptPayload(dataKey, envelope)
    const kdf = { ...DEFAULT_ARGON2_PARAMS, salt: randomBytes(16) }
    const nextEnvelope = {
      ...envelope,
      revision: envelope.revision + 1,
      sync: syncMetadata(),
      kdf,
      wrappedKey: await wrapDataKey(rawDataKey, newPassword, kdf),
      integrity: undefined,
    }
    nextEnvelope.integrity = await createIntegrityRecord(dataKey, nextEnvelope)
    return {
      dataKey,
      envelope: nextEnvelope,
      payload,
      ...(options.includeSessionKeyMaterial ? { sessionKeyMaterial: bytesToBase64(rawDataKey) } : {}),
    }
  } finally {
    rawDataKey?.fill(0)
  }
}

async function openLegacyEnvelope(password, envelope) {
  if (
    envelope?.format !== LEGACY_FORMAT
    || envelope.kdf?.name !== 'PBKDF2'
    || envelope.kdf?.hash !== 'SHA-256'
  ) throw new Error('Unsupported or missing vault.')
  let rawDataKey
  try {
    const wrappingKey = await deriveLegacyWrappingKey(password, envelope.kdf.salt, envelope.kdf.iterations)
    rawDataKey = new Uint8Array(await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toBytes(envelope.wrappedKey.iv),
        additionalData: encoder.encode(`${LEGACY_FORMAT}:wrapped-key`),
        tagLength: 128,
      },
      wrappingKey,
      toBytes(envelope.wrappedKey.ciphertext),
    ))
    const dataKey = await importDataKey(rawDataKey)
    const plaintext = new Uint8Array(await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toBytes(envelope.payload.iv),
        additionalData: encoder.encode(`${LEGACY_FORMAT}:payload`),
        tagLength: 128,
      },
      dataKey,
      toBytes(envelope.payload.ciphertext),
    ))
    try {
      const legacyPayload = JSON.parse(decoder.decode(plaintext))
      if (legacyPayload?.schemaVersion !== 1 || !Array.isArray(legacyPayload.items)) throw new Error('Invalid vault schema.')
      return { rawDataKey, legacyPayload }
    } finally {
      plaintext.fill(0)
    }
  } catch {
    rawDataKey?.fill(0)
    throw new Error('Couldn’t unlock this vault.')
  }
}

export async function migrateLegacyVaultEnvelope(password, legacyEnvelope, options = {}) {
  const opened = await openLegacyEnvelope(password, legacyEnvelope)
  const rawDataKey = opened.rawDataKey
  try {
    const kdf = { ...DEFAULT_ARGON2_PARAMS, salt: randomBytes(16) }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toBytes(legacyEnvelope.wrappedKey.ciphertext)))
    const vaultId = `migrated-${[...digest.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
    digest.fill(0)
    const envelope = {
      format: CURRENT_FORMAT,
      encryptionVersion: ENCRYPTION_VERSION,
      vaultId,
      revision: Math.max(1, Number(legacyEnvelope.revision) || 1) + 1,
      sync: syncMetadata(),
      kdf,
      wrappedKey: await wrapDataKey(rawDataKey, password, kdf),
      recovery: null,
    }
    const dataKey = await importDataKey(rawDataKey)
    const payload = { ...opened.legacyPayload, schemaVersion: PAYLOAD_SCHEMA_VERSION }
    envelope.payload = await encryptPayload(dataKey, envelope, payload)
    envelope.integrity = await createIntegrityRecord(dataKey, envelope)
    return {
      dataKey,
      envelope,
      payload,
      migrated: true,
      ...(options.includeSessionKeyMaterial ? { sessionKeyMaterial: bytesToBase64(rawDataKey) } : {}),
    }
  } finally {
    rawDataKey.fill(0)
  }
}

export async function benchmarkArgon2id({ targetMs = 750, candidates } = {}) {
  const configurations = candidates || [
    { ...DEFAULT_ARGON2_PARAMS, memorySize: MIN_ARGON2_MEMORY_KIB, iterations: MIN_ARGON2_ITERATIONS },
    { ...DEFAULT_ARGON2_PARAMS, memorySize: 32 * 1024, iterations: 3 },
    { ...DEFAULT_ARGON2_PARAMS },
  ]
  const salt = randomBytes(16)
  const measurements = []
  for (const candidate of configurations) {
    validateArgon2Params(candidate)
    const startedAt = performance.now()
    const derived = toBytes(await argon2id({
      password: encoder.encode('Hush Argon2id benchmark only'),
      salt,
      parallelism: candidate.parallelism,
      iterations: candidate.iterations,
      memorySize: candidate.memorySize,
      hashLength: candidate.hashLength,
      outputType: 'binary',
    }))
    const durationMs = performance.now() - startedAt
    derived.fill(0)
    measurements.push({ ...candidate, durationMs })
    if (durationMs > targetMs) break
  }
  salt.fill(0)
  const withinTarget = measurements.filter((measurement) => measurement.durationMs <= targetMs)
  return {
    targetMs,
    selected: withinTarget.at(-1) || measurements[0],
    measurements,
  }
}
