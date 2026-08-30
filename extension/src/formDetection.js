const REGISTRATION_WORDS = /\b(sign\s*up|register|create\s+(?:an?\s+)?account|join)\b/iu
const CHANGE_WORDS = /\b(change|update|reset)\s+(?:your\s+)?password\b/iu
const LOGIN_WORDS = /\b(log\s*in|sign\s*in|continue|next)\b/iu
const USERNAME_WORDS = /(?:user(?:name)?|login|e-?mail|account|identifier)/u
const PASSWORD_WORDS = /(?:password|passphrase|passwd|pwd)/u
const CURRENT_WORDS = /(?:current|old|existing|previous)/u
const NEW_WORDS = /(?:new|create|choose|replacement)/u
const CONFIRMATION_WORDS = /(?:confirm|confirmation|repeat|retype|re-enter|verify)/u

function normalizeField(field = {}) {
  return {
    type: String(field.type || 'text').toLowerCase(),
    autocomplete: String(field.autocomplete || '').toLowerCase(),
    name: String(field.name || '').toLowerCase(),
    label: String(field.label || '').toLowerCase(),
    id: String(field.id || '').toLowerCase(),
    placeholder: String(field.placeholder || '').toLowerCase(),
    visible: field.visible !== false,
  }
}

function autocompleteTokens(field) {
  return new Set(field.autocomplete.split(/\s+/u).filter(Boolean))
}

export function credentialFieldRole(value = {}) {
  const field = normalizeField(value)
  if (!field.visible) return 'unknown'
  const tokens = autocompleteTokens(field)
  const signals = `${field.name} ${field.id} ${field.label} ${field.placeholder}`

  if (tokens.has('one-time-code')) return 'one-time-code'
  if (tokens.has('current-password')) return 'current-password'
  if (tokens.has('new-password')) return CONFIRMATION_WORDS.test(signals) ? 'confirmation-password' : 'new-password'

  const passwordLike = field.type === 'password' || PASSWORD_WORDS.test(signals)
  if (passwordLike) {
    if (CURRENT_WORDS.test(signals)) return 'current-password'
    if (CONFIRMATION_WORDS.test(signals)) return 'confirmation-password'
    if (NEW_WORDS.test(signals)) return 'new-password'
    return 'password'
  }

  if (tokens.has('username') || tokens.has('email') || field.type === 'email' || USERNAME_WORDS.test(signals)) return 'username'
  return 'unknown'
}

export function classifyFormSignals({ fields = [], text = '', path = '' } = {}) {
  const normalized = fields.map(normalizeField).filter((field) => field.visible)
  const roles = normalized.map(credentialFieldRole)
  const passwordRoles = new Set(['password', 'current-password', 'new-password', 'confirmation-password'])
  const passwordFields = normalized.filter((_field, index) => passwordRoles.has(roles[index]))
  const currentFields = normalized.filter((_field, index) => roles[index] === 'current-password')
  const newFields = normalized.filter((_field, index) => roles[index] === 'new-password' || roles[index] === 'confirmation-password')
  const usernameFields = normalized.filter((_field, index) => roles[index] === 'username')
  const context = `${text} ${path}`.replace(/[_-]+/gu, ' ')
  const ambiguousPasswordCount = passwordFields.length >= 2
    && currentFields.length === 0
    && newFields.length === 0
    && !REGISTRATION_WORDS.test(context)
    && !CHANGE_WORDS.test(context)
    ? passwordFields.length
    : 0

  let kind = 'unknown'
  if ((currentFields.length && passwordFields.length >= 2) || (passwordFields.length && CHANGE_WORDS.test(context))) kind = 'password-change'
  else if (newFields.length || (passwordFields.length && REGISTRATION_WORDS.test(context))) kind = 'registration'
  else if (passwordFields.length || LOGIN_WORDS.test(context)) kind = 'login'
  else if (usernameFields.length) kind = 'username-step'

  return {
    kind,
    passwordCount: passwordFields.length,
    currentPasswordCount: currentFields.length,
    newPasswordCount: newFields.length,
    usernameCount: usernameFields.length,
    hasConfirmation: newFields.length >= 2 || passwordFields.length >= 2,
    ambiguousPasswordCount,
  }
}

export function inputDescriptor(input) {
  const id = input.id ? CSS.escape(input.id) : ''
  const explicitLabel = id ? input.ownerDocument?.querySelector(`label[for="${id}"]`)?.textContent : ''
  const wrappingLabel = input.closest?.('label')?.textContent || ''
  const labelledBy = String(input.getAttribute?.('aria-labelledby') || '')
    .split(/\s+/u)
    .filter(Boolean)
    .map((labelId) => input.ownerDocument?.getElementById(labelId)?.textContent || '')
    .join(' ')
  return {
    type: input.type,
    autocomplete: input.autocomplete,
    name: input.name,
    id: input.id,
    placeholder: input.placeholder,
    label: `${explicitLabel || ''} ${wrappingLabel || ''} ${labelledBy} ${input.getAttribute?.('aria-label') || ''}`.trim(),
    visible: input.type !== 'hidden' && !input.disabled && !input.readOnly,
  }
}
