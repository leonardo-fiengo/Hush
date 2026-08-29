const FORM_KINDS = new Set(['login', 'registration', 'password-change', 'username-step', 'unknown'])
const FOCUS_ROLES = new Set(['username', 'password', 'current-password', 'new-password', 'unknown'])

export function normalizeFormRequest(value = {}) {
  return {
    formKind: FORM_KINDS.has(value.formKind) ? value.formKind : 'unknown',
    focusRole: FOCUS_ROLES.has(value.focusRole) ? value.focusRole : 'unknown',
  }
}

export function automaticMatch(matches, preferences, formRequest, multiStep = null) {
  const context = normalizeFormRequest(formRequest)
  const isLoginTarget = context.formKind === 'login' && context.focusRole !== 'new-password'
  const isCurrentPasswordTarget = context.formKind === 'password-change' && context.focusRole === 'current-password'
  if (!isLoginTarget && !isCurrentPasswordTarget) return null

  if (multiStep?.explicitSelection && isLoginTarget && context.focusRole === 'password') {
    const selected = matches.find(({ entry, match }) => entry.id === multiStep.credentialId && match.fillable && match.autoFillSafe)
    if (selected) return { ...selected, reason: 'multi-step-selection' }
  }

  if (preferences?.autofillSingleExact !== true || matches.length !== 1) return null
  const [candidate] = matches
  return candidate.match.fillable && candidate.match.autoFillSafe && candidate.match.matchType === 'exact'
    ? { ...candidate, reason: 'single-exact-preference' }
    : null
}
