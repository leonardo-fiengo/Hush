export const SESSION_VERSION = 1
export const ALLOWED_AUTO_LOCK_MINUTES = Object.freeze([0, 5, 15, 30, 60])

export function normalizeAutoLockMinutes(value) {
  const minutes = Number(value)
  return ALLOWED_AUTO_LOCK_MINUTES.includes(minutes) ? minutes : 15
}

function expiryFrom(now, autoLockMinutes) {
  const minutes = normalizeAutoLockMinutes(autoLockMinutes)
  return minutes === 0 ? null : now + minutes * 60_000
}

export function createSessionRecord({ vaultId, envelopeRevision, sessionKeyMaterial, autoLockMinutes, now = Date.now() }) {
  if (typeof vaultId !== 'string' || vaultId.length < 16) throw new Error('Invalid session vault identity.')
  if (!Number.isInteger(envelopeRevision) || envelopeRevision < 1) throw new Error('Invalid session vault revision.')
  if (typeof sessionKeyMaterial !== 'string' || sessionKeyMaterial.length !== 44) throw new Error('Invalid session vault key.')
  return {
    version: SESSION_VERSION,
    vaultId,
    envelopeRevision,
    sessionKeyMaterial,
    lastActiveAt: now,
    expiresAt: expiryFrom(now, autoLockMinutes),
  }
}

export function sessionRecordIsValid(record) {
  return Boolean(
    record
    && record.version === SESSION_VERSION
    && typeof record.vaultId === 'string'
    && record.vaultId.length >= 16
    && Number.isInteger(record.envelopeRevision)
    && record.envelopeRevision >= 1
    && typeof record.sessionKeyMaterial === 'string'
    && record.sessionKeyMaterial.length === 44
    && Number.isFinite(record.lastActiveAt)
    && (record.expiresAt === null || Number.isFinite(record.expiresAt)),
  )
}

export function sessionExpired(record, now = Date.now()) {
  return !sessionRecordIsValid(record) || (record.expiresAt !== null && now >= record.expiresAt)
}

export function touchSessionRecord(record, autoLockMinutes, now = Date.now()) {
  if (!sessionRecordIsValid(record)) throw new Error('Invalid unlocked session.')
  return {
    ...record,
    lastActiveAt: now,
    expiresAt: expiryFrom(now, autoLockMinutes),
  }
}
