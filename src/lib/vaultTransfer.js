import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate'

const TRANSFER_FORMAT = 'hush-device-envelope-v1'
const PAIRING_FORMAT = 'hush-pair-v1'
const PAIRING_QR_PREFIX = 'HUSHQR1-'

function toBytes(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw new Error('Invalid encrypted byte field.')
}

function bytesToBase64(value) {
  const bytes = toBytes(value)
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function base64ToBytes(value) {
  if (typeof value !== 'string' || !value) throw new Error('Invalid encrypted byte field.')
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function textToBase64Url(value) {
  const bytes = new TextEncoder().encode(value)
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function base64UrlToText(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return new TextDecoder().decode(base64ToBytes(padded))
}

function bytesToBase64Url(value) {
  return bytesToBase64(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function base64UrlToBytes(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  return base64ToBytes(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
}

export function envelopeToTransfer(envelope) {
  if (!envelope || envelope.format !== 'hush-vault-v1') throw new Error('This is not a supported Hush vault.')
  return {
    transferFormat: TRANSFER_FORMAT,
    format: envelope.format,
    revision: Number(envelope.revision) || 0,
    sync: envelope.sync || null,
    kdf: { ...envelope.kdf, salt: bytesToBase64(envelope.kdf?.salt) },
    wrappedKey: {
      ...envelope.wrappedKey,
      iv: bytesToBase64(envelope.wrappedKey?.iv),
      ciphertext: bytesToBase64(envelope.wrappedKey?.ciphertext),
    },
    payload: {
      ...envelope.payload,
      iv: bytesToBase64(envelope.payload?.iv),
      ciphertext: bytesToBase64(envelope.payload?.ciphertext),
    },
  }
}

export function transferToEnvelope(transfer) {
  if (!transfer || transfer.transferFormat !== TRANSFER_FORMAT || transfer.format !== 'hush-vault-v1') {
    throw new Error('This is not a supported Hush device transfer.')
  }
  if (!transfer.kdf || !transfer.wrappedKey || !transfer.payload) throw new Error('The encrypted vault is incomplete.')
  return {
    format: transfer.format,
    revision: Number(transfer.revision) || 0,
    sync: transfer.sync || undefined,
    kdf: { ...transfer.kdf, salt: base64ToBytes(transfer.kdf.salt) },
    wrappedKey: {
      ...transfer.wrappedKey,
      iv: base64ToBytes(transfer.wrappedKey.iv),
      ciphertext: base64ToBytes(transfer.wrappedKey.ciphertext),
    },
    payload: {
      ...transfer.payload,
      iv: base64ToBytes(transfer.payload.iv),
      ciphertext: base64ToBytes(transfer.payload.ciphertext),
    },
  }
}

export function serializeEnvelope(envelope, spacing = 0) {
  const transfer = envelopeToTransfer(envelope)
  if (spacing) transfer.exportedAt = new Date().toISOString()
  return JSON.stringify(transfer, null, spacing)
}

export function deserializeEnvelope(value) {
  return transferToEnvelope(typeof value === 'string' ? JSON.parse(value) : value)
}

export function vaultIdentity(envelope) {
  if (!envelope?.kdf?.salt || !envelope?.wrappedKey?.ciphertext) return ''
  return `${bytesToBase64(envelope.kdf.salt)}:${bytesToBase64(envelope.wrappedKey.ciphertext)}`
}

export function sameVault(left, right) {
  const leftIdentity = vaultIdentity(left)
  return Boolean(leftIdentity && leftIdentity === vaultIdentity(right))
}

export function compareEnvelopeVersions(left, right) {
  const revisionDifference = (Number(left?.revision) || 0) - (Number(right?.revision) || 0)
  if (revisionDifference) return Math.sign(revisionDifference)
  const leftChange = left?.sync?.changeId || ''
  const rightChange = right?.sync?.changeId || ''
  return leftChange === rightChange ? 0 : leftChange > rightChange ? 1 : -1
}

export function encodePairingCode(type, description) {
  if (!['offer', 'answer'].includes(type) || !description?.sdp || description?.type !== type) {
    throw new Error('Could not create a pairing code.')
  }
  return `HUSH1-${textToBase64Url(JSON.stringify({ format: PAIRING_FORMAT, type, description }))}`
}

export function decodePairingCode(value, expectedType) {
  try {
    const compact = String(value || '').replace(/\s+/gu, '')
    if (!compact.startsWith('HUSH1-')) throw new Error()
    const decoded = JSON.parse(base64UrlToText(compact.slice(6)))
    if (decoded.format !== PAIRING_FORMAT || decoded.type !== expectedType || decoded.description?.type !== expectedType || !decoded.description?.sdp) throw new Error()
    return decoded.description
  } catch {
    throw new Error(`That is not a valid Hush ${expectedType} code.`)
  }
}

export function pairingCodeToQr(value) {
  const compact = String(value || '').replace(/\s+/gu, '')
  if (!compact.startsWith('HUSH1-')) throw new Error('That is not a Hush pairing code.')
  const compressed = deflateSync(strToU8(compact), { level: 9 })
  return `${PAIRING_QR_PREFIX}${bytesToBase64Url(compressed)}`
}

export function pairingCodeFromQr(value) {
  try {
    const compact = String(value || '').replace(/\s+/gu, '')
    if (compact.startsWith('HUSH1-')) return compact
    if (!compact.startsWith(PAIRING_QR_PREFIX)) throw new Error()
    const pairingCode = strFromU8(inflateSync(base64UrlToBytes(compact.slice(PAIRING_QR_PREFIX.length))))
    if (!pairingCode.startsWith('HUSH1-')) throw new Error()
    return pairingCode
  } catch {
    throw new Error('That QR code was not created by Hush.')
  }
}

export { TRANSFER_FORMAT }
