import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate'

const TRANSFER_FORMAT = 'hush-device-envelope-v2'
const LEGACY_TRANSFER_FORMAT = 'hush-device-envelope-v1'
const SUPPORTED_VAULT_FORMATS = new Set(['hush-vault-v1', 'hush-vault-v2'])
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
  if (typeof value !== 'string' || !value || value.length > 70_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error('Invalid encrypted byte field.')
  }
  let binary
  try {
    binary = atob(value)
  } catch {
    throw new Error('Invalid encrypted byte field.')
  }
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
  if (!envelope || !SUPPORTED_VAULT_FORMATS.has(envelope.format)) throw new Error('This is not a supported Hush vault.')
  const transfer = {
    transferFormat: envelope.format === 'hush-vault-v2' ? TRANSFER_FORMAT : LEGACY_TRANSFER_FORMAT,
    format: envelope.format,
    encryptionVersion: envelope.encryptionVersion,
    vaultId: envelope.vaultId,
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
  if (envelope.recovery) {
    transfer.recovery = {
      kdf: { ...envelope.recovery.kdf, salt: bytesToBase64(envelope.recovery.kdf?.salt) },
      wrappedKey: {
        ...envelope.recovery.wrappedKey,
        iv: bytesToBase64(envelope.recovery.wrappedKey?.iv),
        ciphertext: bytesToBase64(envelope.recovery.wrappedKey?.ciphertext),
      },
    }
  } else if (envelope.format === 'hush-vault-v2') {
    transfer.recovery = null
  }
  if (envelope.integrity) {
    transfer.integrity = {
      ...envelope.integrity,
      iv: bytesToBase64(envelope.integrity?.iv),
      ciphertext: bytesToBase64(envelope.integrity?.ciphertext),
    }
  }
  return transfer
}

export function transferToEnvelope(transfer) {
  const validTransferFormat = transfer?.transferFormat === TRANSFER_FORMAT || transfer?.transferFormat === LEGACY_TRANSFER_FORMAT
  if (!transfer || !validTransferFormat || !SUPPORTED_VAULT_FORMATS.has(transfer.format)) {
    throw new Error('This is not a supported Hush device transfer.')
  }
  if (!transfer.kdf || !transfer.wrappedKey || !transfer.payload) throw new Error('The encrypted vault is incomplete.')
  if (transfer.format === 'hush-vault-v2' && (!transfer.vaultId || !transfer.integrity)) throw new Error('The encrypted vault is incomplete.')
  const envelope = {
    format: transfer.format,
    encryptionVersion: transfer.encryptionVersion,
    vaultId: transfer.vaultId,
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
  if (transfer.recovery) {
    if (!transfer.recovery.kdf || !transfer.recovery.wrappedKey) throw new Error('The recovery data is incomplete.')
    envelope.recovery = {
      kdf: { ...transfer.recovery.kdf, salt: base64ToBytes(transfer.recovery.kdf.salt) },
      wrappedKey: {
        ...transfer.recovery.wrappedKey,
        iv: base64ToBytes(transfer.recovery.wrappedKey.iv),
        ciphertext: base64ToBytes(transfer.recovery.wrappedKey.ciphertext),
      },
    }
  } else if (transfer.format === 'hush-vault-v2') {
    envelope.recovery = null
  }
  if (transfer.integrity) {
    envelope.integrity = {
      ...transfer.integrity,
      iv: base64ToBytes(transfer.integrity.iv),
      ciphertext: base64ToBytes(transfer.integrity.ciphertext),
    }
  }
  return envelope
}

export function serializeEnvelope(envelope, spacing = 0) {
  const transfer = envelopeToTransfer(envelope)
  if (spacing) transfer.exportedAt = new Date().toISOString()
  return JSON.stringify(transfer, null, spacing)
}

export function deserializeEnvelope(value) {
  if (typeof value === 'string' && value.length > 70_000_000) throw new Error('That Hush archive is too large.')
  let transfer
  try {
    transfer = typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    throw new Error('That file is not a valid Hush archive.')
  }
  return transferToEnvelope(transfer)
}

export function vaultIdentity(envelope) {
  if (envelope?.format === 'hush-vault-v2' && envelope.vaultId) return envelope.vaultId
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
