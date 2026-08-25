export const PASSWORD_RISK_SCORE = 65
export const PASSWORD_RISK_AGE_DAYS = null

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'qwerty', 'qwerty123',
  'letmein', 'welcome', 'welcome1', 'admin', 'administrator', 'iloveyou',
  'monkey', 'dragon', 'football', 'baseball', 'abc123', '123456', '12345678',
  '123456789', '1234567890', '111111', '000000', '1q2w3e4r', 'qwertyuiop',
])

const KEYBOARD_RUNS = [
  'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', '0987654321',
  'poiuytrewq', 'lkjhgfdsa', 'mnbvcxz',
]

const GENERIC_WORDS = [
  'password', 'pass', 'secret', 'login', 'admin', 'welcome', 'user', 'account',
  'love', 'hello', 'master', 'access', 'security', 'private',
]

function normalize(value = '') {
  return String(value).normalize('NFKC').toLowerCase()
}

function compact(value = '') {
  return normalize(value).replace(/[^a-z0-9]/g, '')
}

function contextTokens(entry) {
  const values = [entry?.name, entry?.username]
  if (entry?.username?.includes('@')) values.push(entry.username.split('@')[0])
  if (entry?.url) {
    try {
      const parsed = new URL(/^https?:\/\//i.test(entry.url) ? entry.url : `https://${entry.url}`)
      values.push(parsed.hostname.replace(/^www\./, '').split('.')[0])
    } catch {
      values.push(entry.url)
    }
  }
  return values
    .flatMap((value) => normalize(value).split(/[^a-z0-9]+/))
    .map(compact)
    .filter((token) => token.length >= 4)
}

function hasSequence(password) {
  const value = compact(password)
  if (!value) return false
  if (KEYBOARD_RUNS.some((run) => {
    for (let size = 4; size <= run.length; size += 1) {
      for (let index = 0; index <= run.length - size; index += 1) {
        if (value.includes(run.slice(index, index + size))) return true
      }
    }
    return false
  })) return true

  for (let index = 0; index <= value.length - 4; index += 1) {
    const chunk = value.slice(index, index + 4)
    const codes = [...chunk].map((character) => character.charCodeAt(0))
    const ascending = codes.every((code, offset) => offset === 0 || code === codes[offset - 1] + 1)
    const descending = codes.every((code, offset) => offset === 0 || code === codes[offset - 1] - 1)
    if (ascending || descending) return true
  }
  return false
}

function hasRepeatedPattern(password) {
  const value = normalize(password)
  if (/(.)\1{3,}/u.test(value)) return true
  if (/^(.{1,6})\1{2,}$/u.test(value)) return true
  return false
}

function hasCommonWord(password) {
  const value = compact(password)
  return GENERIC_WORDS.some((word) => value.includes(word))
}

function containsContext(password, entry) {
  const value = compact(password)
  return contextTokens(entry).some((token) => value.includes(token))
}

function looksLikeYearOrDate(password) {
  const value = normalize(password)
  return /(?:19|20)\d{2}/.test(value)
    || /(?:0?[1-9]|[12]\d|3[01])[-/.](?:0?[1-9]|1[0-2])[-/.](?:\d{2}|\d{4})/.test(value)
}

function estimateStrength(password, entry = {}) {
  const value = String(password || '')
  if (!value) return { value: 0, flags: ['empty'] }

  const normalized = normalize(value)
  const simplified = compact(value)
  const flags = []

  if (COMMON_PASSWORDS.has(normalized) || COMMON_PASSWORDS.has(simplified)) flags.push('common')
  if (value.length < 12) flags.push('short')
  if (hasSequence(value)) flags.push('sequence')
  if (hasRepeatedPattern(value)) flags.push('repeat')
  if (hasCommonWord(value)) flags.push('word')
  if (containsContext(value, entry)) flags.push('context')
  if (looksLikeYearOrDate(value)) flags.push('date')

  // Length is the main positive signal. Character variety only provides a small
  // bonus; it is deliberately not treated as a composition requirement.
  let score = Math.min(96, 18 + value.length * 3.4)
  if (value.length >= 16) score += 5
  if (value.length >= 20) score += 5
  if (value.length >= 28) score += 3

  const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].filter((test) => test.test(value)).length
  score += Math.max(0, variety - 1) * 2

  if (flags.includes('common')) score = Math.min(score, 12)
  if (flags.includes('short')) score -= value.length < 8 ? 28 : 16
  if (flags.includes('sequence')) score -= 24
  if (flags.includes('repeat')) score -= 22
  if (flags.includes('word')) score -= 16
  if (flags.includes('context')) score -= 24
  if (flags.includes('date')) score -= 10

  return { value: Math.max(0, Math.min(100, Math.round(score))), flags }
}

export function countPasswords(entries) {
  const counts = new Map()
  entries.forEach((entry) => {
    const password = entry.password || ''
    if (password) counts.set(password, (counts.get(password) || 0) + 1)
  })
  return counts
}

export function passwordHealth(entry, passwordCounts = new Map()) {
  const reused = (passwordCounts.get(entry.password) || 0) > 1
  const estimated = estimateStrength(entry.password, entry)
  const flags = reused ? ['reused', ...estimated.flags] : estimated.flags
  const value = reused ? Math.min(35, estimated.value) : estimated.value

  if (reused) return { label: 'Reused', tone: 'danger', value, flags }
  if (value < 25) return { label: 'Critical', tone: 'danger', value, flags }
  if (value < 45) return { label: 'Weak', tone: 'danger', value, flags }
  if (value < PASSWORD_RISK_SCORE) return { label: 'Fair', tone: 'warn', value, flags }
  if (value < 80) return { label: 'Good', tone: 'good', value, flags }
  if (value < 95) return { label: 'Strong', tone: 'good', value, flags }
  return { label: 'Excellent', tone: 'good', value, flags }
}

export function passwordAgeDays(entry, now = Date.now()) {
  const changedAt = entry.passwordChangedAt || entry.updatedAt || entry.createdAt
  const changedTime = new Date(changedAt).getTime()
  if (!Number.isFinite(changedTime)) return null
  return Math.max(0, Math.floor((now - changedTime) / 86_400_000))
}

function primaryReason(health) {
  const flags = new Set(health.flags || [])
  if (flags.has('reused')) return ['Reused in this vault', 'Reused password']
  if (flags.has('common')) return ['Matches a very common password', 'Common password']
  if (flags.has('context')) return ['Contains account or service information', 'Uses account info']
  if (flags.has('sequence')) return ['Contains a predictable sequence', 'Predictable sequence']
  if (flags.has('repeat')) return ['Contains a repeated pattern', 'Repeated pattern']
  if (flags.has('word')) return ['Contains a predictable password word', 'Predictable word']
  if (flags.has('short')) return ['Too short to resist guessing well', 'Too short']
  if (flags.has('date')) return ['Contains a predictable year or date', 'Predictable date']
  return [`${health.value}% local strength score`, `${health.value}% strength`]
}

export function passwordRisk(entry, passwordCounts, now = Date.now()) {
  const health = passwordHealth(entry, passwordCounts)
  const ageDays = passwordAgeDays(entry, now)
  const lowStrength = health.value < PASSWORD_RISK_SCORE
  const reused = health.flags?.includes('reused') || false
  const atRisk = lowStrength || reused
  const [reason, shortReason] = atRisk
    ? primaryReason(health)
    : ['No current risk flags', `${health.value}% strength`]

  return {
    ageDays,
    atRisk,
    health,
    lowStrength,
    reason,
    reused,
    shortReason,
    // Kept for backwards-compatible UI code. Password age is informational only;
    // routine forced rotation is not treated as a security risk.
    stale: false,
    tone: atRisk ? (health.value < 45 || reused ? 'danger' : 'warn') : health.tone,
  }
}

export function vaultHealthScore(entries, passwordCounts = countPasswords(entries)) {
  if (!entries.length) return 100
  const scores = entries.map((entry) => passwordHealth(entry, passwordCounts).value).sort((a, b) => a - b)
  const average = scores.reduce((total, value) => total + value, 0) / scores.length
  const worstCount = Math.max(1, Math.ceil(scores.length * 0.1))
  const worstAverage = scores.slice(0, worstCount).reduce((total, value) => total + value, 0) / worstCount
  let score = Math.round(average * 0.7 + worstAverage * 0.3)
  if (entries.some((entry) => passwordHealth(entry, passwordCounts).flags?.includes('reused'))) score = Math.min(score, 79)
  return Math.max(0, Math.min(100, score))
}

export function masterPasswordHealth(password) {
  const health = passwordHealth({ password, name: '', username: '', url: '' }, new Map())
  const sufficientlyLong = String(password || '').length >= 14
  return {
    ...health,
    acceptable: sufficientlyLong && health.value >= 65,
  }
}
