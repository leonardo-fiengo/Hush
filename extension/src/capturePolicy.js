export function existingCredentialForCapture(matches, { kind, username, currentPassword, credentialId } = {}) {
  if (credentialId) {
    const selected = matches.find(({ entry }) => entry.id === credentialId)
    if (selected) return selected
  }
  if (kind === 'password-change' && currentPassword) {
    const currentPasswordMatches = matches.filter(({ entry }) => entry.password === currentPassword)
    if (currentPasswordMatches.length === 1) return currentPasswordMatches[0]
  }
  if (username) {
    const usernameMatches = matches.filter(({ entry }) => entry.username === username)
    if (usernameMatches.length === 1) return usernameMatches[0]
  }
  if (!username && matches.length === 1) {
    const [onlyMatch] = matches
    if (onlyMatch.match?.fillable && onlyMatch.match.matchType === 'exact') return onlyMatch
  }
  return null
}

export function credentialCaptureOperation(existing, submittedPassword) {
  if (existing?.entry?.password === submittedPassword) return 'unchanged'
  return existing ? 'update' : 'save'
}
