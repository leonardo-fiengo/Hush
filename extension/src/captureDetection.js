import { credentialFieldRole } from './formDetection.js'

const PASSWORD_ROLES = new Set(['password', 'current-password', 'new-password', 'confirmation-password'])

function preparedFields(fields = []) {
  return fields.map((field, index) => ({
    field,
    index,
    role: credentialFieldRole(field),
    value: String(field.value || ''),
  }))
}

function firstValue(fields, role) {
  return fields.find((candidate) => candidate.role === role && candidate.value)?.value || ''
}

function confirmationMismatch(primary, confirmations) {
  return confirmations.some((candidate) => candidate.value && candidate.value !== primary.value)
}

function newPasswordSelection(passwords, kind) {
  const explicitCurrent = passwords.find((candidate) => candidate.role === 'current-password') || null
  const explicitNew = passwords.filter((candidate) => candidate.role === 'new-password')
  const explicitConfirmations = passwords.filter((candidate) => candidate.role === 'confirmation-password')
  const generic = passwords.filter((candidate) => candidate.role === 'password')

  if (explicitNew.length) {
    const primary = explicitNew[0]
    return {
      primary,
      current: explicitCurrent || generic.find((candidate) => candidate.index < primary.index) || null,
      confirmations: [...explicitNew.slice(1), ...explicitConfirmations],
    }
  }

  if (kind === 'registration') {
    const primary = generic[0] || explicitConfirmations[0] || null
    return { primary, current: null, confirmations: [...generic.slice(1), ...explicitConfirmations.filter((candidate) => candidate !== primary)] }
  }

  if (explicitCurrent) {
    const primary = generic.find((candidate) => candidate !== explicitCurrent) || explicitConfirmations[0] || null
    return { primary, current: explicitCurrent, confirmations: explicitConfirmations.filter((candidate) => candidate !== primary) }
  }

  if (generic.length >= 3) return { primary: generic[1], current: generic[0], confirmations: [...generic.slice(2), ...explicitConfirmations] }
  if (generic.length === 2 && generic[0].value !== generic[1].value) return { primary: generic[1], current: generic[0], confirmations: explicitConfirmations }
  const primary = generic[0] || explicitConfirmations[0] || null
  return { primary, current: null, confirmations: [...generic.slice(1), ...explicitConfirmations.filter((candidate) => candidate !== primary)] }
}

export function credentialIdentityFromFields(fields = [], fallbackUsername = '') {
  const prepared = preparedFields(fields)
  return {
    username: firstValue(prepared, 'username') || String(fallbackUsername || ''),
    currentPassword: firstValue(prepared, 'current-password'),
  }
}

export function inferredCaptureKind(fields = [], analysis = {}) {
  if (!analysis.ambiguousPasswordCount) return analysis.kind || 'unknown'
  const passwords = preparedFields(fields).filter((candidate) => PASSWORD_ROLES.has(candidate.role) && candidate.value)
  if (passwords.length >= 3 && passwords.at(-1).value === passwords.at(-2).value) return 'password-change'
  if (passwords.length === 2 && passwords[0].value === passwords[1].value) return 'registration'
  return analysis.kind || 'unknown'
}

export function credentialCaptureFromFields({ fields = [], kind = 'unknown', fallbackUsername = '' } = {}) {
  const prepared = preparedFields(fields)
  const passwords = prepared.filter((candidate) => PASSWORD_ROLES.has(candidate.role))
  const username = firstValue(prepared, 'username') || String(fallbackUsername || '')

  if (kind === 'registration' || kind === 'password-change') {
    const selection = newPasswordSelection(passwords, kind)
    if (!selection.primary?.value) return { ok: false, reason: 'missing-password' }
    if (confirmationMismatch(selection.primary, selection.confirmations)) return { ok: false, reason: 'password-mismatch' }
    return {
      ok: true,
      kind,
      username,
      password: selection.primary.value,
      currentPassword: selection.current?.value || '',
    }
  }

  if (kind === 'login') {
    const password = passwords.find((candidate) => candidate.role === 'current-password' && candidate.value)
      || passwords.find((candidate) => candidate.role === 'password' && candidate.value)
    if (!password) return { ok: false, reason: 'missing-password' }
    return { ok: true, kind, username, password: password.value, currentPassword: '' }
  }

  return { ok: false, reason: 'unsupported-form' }
}
