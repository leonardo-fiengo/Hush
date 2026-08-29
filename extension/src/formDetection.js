const REGISTRATION_WORDS = /\b(sign\s*up|register|create\s+(?:an?\s+)?account|join)\b/iu
const CHANGE_WORDS = /\b(change|update|reset)\s+(?:your\s+)?password\b/iu
const LOGIN_WORDS = /\b(log\s*in|sign\s*in|continue|next)\b/iu

function normalizeField(field = {}) {
  return {
    type: String(field.type || 'text').toLowerCase(),
    autocomplete: String(field.autocomplete || '').toLowerCase(),
    name: String(field.name || '').toLowerCase(),
    label: String(field.label || '').toLowerCase(),
    visible: field.visible !== false,
  }
}

function isUsernameField(field) {
  return field.visible && (
    field.autocomplete === 'username'
    || field.type === 'email'
    || /(?:user|login|email|account)/u.test(`${field.name} ${field.label}`)
  )
}

export function classifyFormSignals({ fields = [], text = '', path = '' } = {}) {
  const normalized = fields.map(normalizeField).filter((field) => field.visible)
  const passwordFields = normalized.filter((field) => field.type === 'password')
  const currentFields = passwordFields.filter((field) => field.autocomplete === 'current-password' || /current|old/u.test(`${field.name} ${field.label}`))
  const newFields = passwordFields.filter((field) => field.autocomplete === 'new-password' || /new|confirm|repeat/u.test(`${field.name} ${field.label}`))
  const usernameFields = normalized.filter(isUsernameField)
  const context = `${text} ${path}`.replace(/[_-]+/gu, ' ')

  let kind = 'unknown'
  if (currentFields.length && newFields.length) kind = 'password-change'
  else if (newFields.length || (passwordFields.length >= 2 && (REGISTRATION_WORDS.test(context) || CHANGE_WORDS.test(context)))) kind = CHANGE_WORDS.test(context) ? 'password-change' : 'registration'
  else if (passwordFields.length || LOGIN_WORDS.test(context)) kind = 'login'
  else if (usernameFields.length) kind = 'username-step'

  return {
    kind,
    passwordCount: passwordFields.length,
    currentPasswordCount: currentFields.length,
    newPasswordCount: newFields.length,
    usernameCount: usernameFields.length,
    hasConfirmation: newFields.length >= 2 || passwordFields.length >= 2,
  }
}

export function inputDescriptor(input) {
  const id = input.id ? CSS.escape(input.id) : ''
  const explicitLabel = id ? input.ownerDocument?.querySelector(`label[for="${id}"]`)?.textContent : ''
  const wrappingLabel = input.closest?.('label')?.textContent || ''
  return {
    type: input.type,
    autocomplete: input.autocomplete,
    name: input.name,
    label: `${explicitLabel || ''} ${wrappingLabel || ''} ${input.getAttribute?.('aria-label') || ''}`.trim(),
    visible: input.type !== 'hidden' && !input.disabled && !input.readOnly,
  }
}
