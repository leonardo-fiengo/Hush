export function automaticPasswordUpdateEligible({
  preferenceEnabled,
  kind,
  operation,
  existing,
  identifiedUnambiguously,
  ambiguousForm,
} = {}) {
  const match = existing?.match
  return preferenceEnabled === true
    && kind === 'login'
    && operation === 'update'
    && identifiedUnambiguously === true
    && ambiguousForm !== true
    && match?.matchType === 'exact'
    && match.fillable === true
    && match.autoFillSafe === true
    && match.requiresConfirmation !== true
}

export function createAutomaticUpdateUndo(previousEntry, updatedEntry, { origin, hostname, createdAt = Date.now() } = {}) {
  if (!previousEntry?.id || previousEntry.id !== updatedEntry?.id || previousEntry.password === updatedEntry.password) throw new Error('Invalid automatic-update rollback.')
  return {
    origin,
    hostname,
    credentialId: previousEntry.id,
    expectedPassword: updatedEntry.password,
    expectedRevision: updatedEntry.revision,
    previous: {
      username: previousEntry.username,
      password: previousEntry.password,
      passwordChangedAt: previousEntry.passwordChangedAt,
      passwordHistory: previousEntry.passwordHistory || [],
      encryptionVersion: previousEntry.encryptionVersion,
    },
    createdAt,
  }
}

export function restoreAutomaticUpdate(entry, undo, now = new Date().toISOString()) {
  if (!entry
    || !undo
    || entry.id !== undo.credentialId
    || entry.password !== undo.expectedPassword
    || entry.revision !== undo.expectedRevision
    || typeof undo.previous?.password !== 'string') throw new Error('That automatic update can no longer be undone safely.')
  return {
    ...entry,
    username: undo.previous.username,
    password: undo.previous.password,
    passwordChangedAt: undo.previous.passwordChangedAt,
    passwordHistory: undo.previous.passwordHistory,
    encryptionVersion: undo.previous.encryptionVersion || entry.encryptionVersion,
    updatedAt: now,
    revision: (entry.revision || 1) + 1,
  }
}
