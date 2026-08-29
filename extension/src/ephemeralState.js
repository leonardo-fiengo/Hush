const VERSION = 1
const MAX_PLAINTEXT_BYTES = 32 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function bytesToBase64(value) {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value, expectedLength = null) {
  if (typeof value !== 'string' || !value || value.length > 100_000 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new Error('Invalid encrypted temporary state.')
  let binary
  try {
    binary = atob(value)
  } catch {
    throw new Error('Invalid encrypted temporary state.')
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (expectedLength !== null && bytes.length !== expectedLength) throw new Error('Invalid encrypted temporary state.')
  return bytes
}

function validatePurpose(purpose) {
  if (typeof purpose !== 'string' || !/^[a-z-]{3,40}$/u.test(purpose)) throw new Error('Invalid temporary-state purpose.')
  return purpose
}

function additionalData(purpose, expiresAt) {
  return encoder.encode(`hush-ephemeral-state-v${VERSION}:${purpose}:${expiresAt}`)
}

export async function sealEphemeralState(dataKey, value, { purpose, expiresAt }) {
  validatePurpose(purpose)
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('Invalid temporary-state expiry.')
  const plaintext = encoder.encode(JSON.stringify(value))
  if (!plaintext.length || plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error('Temporary state is too large.')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  try {
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
      name: 'AES-GCM',
      iv,
      additionalData: additionalData(purpose, expiresAt),
      tagLength: 128,
    }, dataKey, plaintext))
    return {
      version: VERSION,
      purpose,
      expiresAt,
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(ciphertext),
    }
  } finally {
    plaintext.fill(0)
  }
}

export async function openEphemeralState(dataKey, record, { purpose, now = Date.now() }) {
  validatePurpose(purpose)
  if (!record
    || record.version !== VERSION
    || record.purpose !== purpose
    || !Number.isFinite(record.expiresAt)
    || now >= record.expiresAt) throw new Error('Temporary state expired.')
  const iv = base64ToBytes(record.iv, 12)
  const ciphertext = base64ToBytes(record.ciphertext)
  if (ciphertext.length < 17 || ciphertext.length > MAX_PLAINTEXT_BYTES + 16) throw new Error('Invalid encrypted temporary state.')
  let plaintext
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv,
      additionalData: additionalData(purpose, record.expiresAt),
      tagLength: 128,
    }, dataKey, ciphertext))
    const value = JSON.parse(decoder.decode(plaintext))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid encrypted temporary state.')
    return value
  } catch {
    throw new Error('Invalid encrypted temporary state.')
  } finally {
    iv.fill(0)
    ciphertext.fill(0)
    plaintext?.fill(0)
  }
}
