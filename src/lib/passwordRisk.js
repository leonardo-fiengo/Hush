export const PASSWORD_RISK_SCORE = 70
export const PASSWORD_RISK_AGE_DAYS = 30

export function countPasswords(entries) {
  const counts = new Map()
  entries.forEach((entry) => counts.set(entry.password, (counts.get(entry.password) || 0) + 1))
  return counts
}

export function passwordHealth(entry, passwordCounts) {
  if ((passwordCounts.get(entry.password) || 0) > 1) return { label: 'Reused', tone: 'danger', value: 28 }
  const password = entry.password || ''
  const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].filter((test) => test.test(password)).length
  if (password.length < 14 || variety < 3) return { label: 'Weak', tone: 'warn', value: 52 }
  return { label: 'Strong', tone: 'good', value: Math.min(98, 70 + password.length) }
}

export function passwordAgeDays(entry, now = Date.now()) {
  const changedAt = entry.passwordChangedAt || entry.updatedAt || entry.createdAt
  const changedTime = new Date(changedAt).getTime()
  if (!Number.isFinite(changedTime)) return null
  return Math.max(0, Math.floor((now - changedTime) / 86_400_000))
}

export function passwordRisk(entry, passwordCounts, now = Date.now()) {
  const health = passwordHealth(entry, passwordCounts)
  const ageDays = passwordAgeDays(entry, now)
  const lowStrength = health.value < PASSWORD_RISK_SCORE
  const stale = ageDays === null || ageDays >= PASSWORD_RISK_AGE_DAYS
  const atRisk = lowStrength || stale
  let reason = 'No current risk flags'
  let shortReason = `${health.value}% strength`
  if (lowStrength && ageDays === null) {
    reason = `${health.value}% strength · change date unknown`
    shortReason = `${health.value}% · date unknown`
  } else if (lowStrength && stale) {
    reason = `${health.value}% strength · unchanged ${ageDays} days`
    shortReason = `${health.value}% · ${ageDays}d unchanged`
  } else if (lowStrength) {
    reason = `${health.value}% strength · below ${PASSWORD_RISK_SCORE}%`
  } else if (ageDays === null) {
    reason = 'Password change date unknown'
    shortReason = 'Change date unknown'
  } else if (stale) {
    reason = `Unchanged for ${ageDays} days`
    shortReason = `${ageDays}d unchanged`
  }

  return {
    ageDays,
    atRisk,
    health,
    lowStrength,
    reason,
    shortReason,
    stale,
    tone: lowStrength ? 'danger' : stale ? 'warn' : health.tone,
  }
}
