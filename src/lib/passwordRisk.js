export const PASSWORD_RISK_SCORE = 65
export const PASSWORD_RISK_AGE_DAYS = null

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'p@ssw0rd', 'qwerty', 'qwerty123',
  'letmein', 'welcome', 'welcome1', 'admin', 'administrator', 'iloveyou', 'changeme',
  'monkey', 'dragon', 'football', 'baseball', 'abc123', '123456', '12345678',
  '123456789', '1234567890', '111111', '000000', '1q2w3e4r', 'qwertyuiop',
  'sunshine', 'princess', 'login', 'secret', 'master', 'trustno1', 'whatever',
])

const DICTIONARY_WORDS = new Set([
  'access', 'account', 'admin', 'apple', 'autumn', 'baby', 'baseball', 'basketball',
  'beach', 'blue', 'business', 'change', 'coffee', 'computer', 'dragon', 'family',
  'flower', 'football', 'forever', 'freedom', 'friend', 'garden', 'hello', 'hockey',
  'home', 'house', 'internet', 'letmein', 'login', 'love', 'master', 'money', 'monkey',
  'music', 'office', 'orange', 'password', 'private', 'purple', 'qwerty', 'secret',
  'security', 'shadow', 'soccer', 'spring', 'star', 'summer', 'sunshine', 'trust',
  'welcome', 'whatever', 'winter', 'work', 'river', 'cobalt', 'museum', 'orbit',
  'glass', 'violet', 'harbor', 'comet', 'maple', 'tundra', 'signal', 'copper',
])

const COMMON_NAMES = new Set([
  'alex', 'andrea', 'anna', 'antonio', 'charles', 'chris', 'daniel', 'david',
  'emma', 'francesco', 'giuseppe', 'james', 'jennifer', 'john', 'joseph', 'laura',
  'leonardo', 'lisa', 'luca', 'maria', 'marco', 'mary', 'michael', 'robert', 'sarah',
  'simone', 'stefano', 'thomas', 'william',
])

const KEYBOARD_RUNS = [
  'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', '0987654321',
  'poiuytrewq', 'lkjhgfdsa', 'mnbvcxz', '1qaz2wsx', 'qazwsx',
]

const COMMON_PREFIXES = ['my', 'the', 'super', 'best', 'new']
const COMMON_SUFFIXES = ['123', '1234', '1', '!', '!!', '2024', '2025', '2026', '2027']
const LEET_MAP = new Map([['@', 'a'], ['4', 'a'], ['3', 'e'], ['1', 'i'], ['!', 'i'], ['0', 'o'], ['5', 's'], ['$', 's'], ['7', 't'], ['+', 't']])

function normalize(value = '') {
  return String(value).normalize('NFKC').toLowerCase()
}

function compact(value = '') {
  return normalize(value).replace(/[^a-z0-9]/g, '')
}

function deLeet(value = '') {
  return [...normalize(value)].map((character) => LEET_MAP.get(character) || character).join('')
}

function words(value = '') {
  return normalize(value).match(/[a-z]{3,}/gu) || []
}

function contextTokens(entry) {
  const values = [entry?.name, entry?.username]
  if (entry?.username?.includes('@')) values.push(entry.username.split('@')[0])
  if (entry?.url) {
    try {
      const parsed = new URL(/^https?:\/\//iu.test(entry.url) ? entry.url : `https://${entry.url}`)
      values.push(parsed.hostname.replace(/^www\./u, '').split('.')[0])
    } catch {
      values.push(entry.url)
    }
  }
  return values
    .flatMap((value) => normalize(value).split(/[^a-z0-9]+/u))
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

function repeatedPattern(password) {
  const value = normalize(password)
  const chunks = words(value)
  return /(.)\1{3,}/u.test(value)
    || /^(.{1,8})\1{2,}$/u.test(value)
    || new Set(chunks).size < chunks.length
}

function containsContext(password, entry) {
  const value = compact(password)
  return contextTokens(entry).some((token) => value.includes(token))
}

function looksLikeYearOrDate(password) {
  const value = normalize(password)
  return /(?:19|20)\d{2}/u.test(value)
    || /(?:0?[1-9]|[12]\d|3[01])[-/.](?:0?[1-9]|1[0-2])[-/.](?:\d{2}|\d{4})/u.test(value)
}

function isMultiWordPassphrase(password) {
  const parts = words(password)
  return parts.length >= 4 && new Set(parts).size === parts.length && String(password).length >= 20
}

function charsetSize(value) {
  let size = 0
  if (/[a-z]/u.test(value)) size += 26
  if (/[A-Z]/u.test(value)) size += 26
  if (/\d/u.test(value)) size += 10
  if (/[^a-zA-Z\d]/u.test(value)) size += 33
  return Math.max(1, size)
}

function commonWordMatches(password) {
  const valueWords = words(password)
  const simplified = compact(password)
  return [...DICTIONARY_WORDS].filter((word) => valueWords.includes(word) || simplified.includes(word))
}

function estimatePasswordGuessability(password, entry = {}) {
  const value = String(password || '')
  if (!value) return { value: 0, flags: ['empty'], entropyBits: 0, estimatedGuesses: 1 }

  const normalized = normalize(value)
  const simplified = compact(value)
  const deLeeted = compact(deLeet(value))
  const valueWords = words(value)
  const dictionaryMatches = commonWordMatches(value)
  const passphrase = isMultiWordPassphrase(value)
  const flags = []

  if (COMMON_PASSWORDS.has(normalized) || COMMON_PASSWORDS.has(simplified) || COMMON_PASSWORDS.has(deLeeted)) flags.push('common')
  if (value.length < 12) flags.push('short')
  if (hasSequence(value)) flags.push('sequence')
  if (repeatedPattern(value)) flags.push(valueWords.length > 1 ? 'repeated-word' : 'repeat')
  if (!passphrase && dictionaryMatches.length) flags.push('dictionary')
  if (valueWords.some((word) => COMMON_NAMES.has(word))) flags.push('name')
  if (containsContext(value, entry)) flags.push('context')
  if (looksLikeYearOrDate(value)) flags.push('date')
  if (!passphrase && /[043@$57+]/u.test(value) && deLeeted !== simplified && [...DICTIONARY_WORDS].some((word) => deLeeted.includes(word))) flags.push('leet')
  if (!passphrase && (COMMON_PREFIXES.some((prefix) => simplified.startsWith(prefix)) || COMMON_SUFFIXES.some((suffix) => normalized.endsWith(suffix)))) flags.push('affix')
  if (!passphrase && /^[A-Z][a-z]+(?:\d{1,4}|[!?])?$/u.test(value)) flags.push('capitalization')
  if (!passphrase && dictionaryMatches.length && /(?:19|20)?\d{2,4}[!?]?$/u.test(value)) flags.push('word-number')
  if (passphrase) flags.push('passphrase')

  let entropyBits = value.length * Math.log2(charsetSize(value))
  if (passphrase) {
    const numericBits = /\d/u.test(value) ? Math.min(10, (value.match(/\d/gu) || []).length * Math.log2(10)) : 0
    entropyBits = Math.min(entropyBits, valueWords.length * Math.log2(7776) + numericBits + 2)
  }
  if (flags.includes('common')) entropyBits = Math.min(entropyBits, 12)
  if (flags.includes('dictionary')) entropyBits = Math.min(entropyBits, 28 + Math.max(0, value.length - dictionaryMatches.join('').length) * 3)
  if (flags.includes('name')) entropyBits = Math.min(entropyBits, 32)
  if (flags.includes('sequence')) entropyBits -= 18
  if (flags.includes('repeat') || flags.includes('repeated-word')) entropyBits -= 18
  if (flags.includes('context')) entropyBits -= 20
  if (flags.includes('date')) entropyBits -= 10
  if (flags.includes('leet')) entropyBits -= 8
  if (flags.includes('affix')) entropyBits -= 6
  if (flags.includes('capitalization')) entropyBits -= 5
  if (flags.includes('word-number')) entropyBits = Math.min(entropyBits, 34)
  if (flags.includes('short')) entropyBits -= value.length < 8 ? 14 : 7
  entropyBits = Math.max(0, Math.min(332, entropyBits))

  // A deliberately conservative mapping: roughly 20 bits starts the scale and
  // 70 bits reaches the top. This is an estimate, never an exact crack-time claim.
  let score = Math.round(((entropyBits - 20) / 50) * 100)
  if (flags.includes('common')) score = Math.min(score, 12)
  score = Math.max(0, Math.min(100, score))
  const estimatedGuesses = entropyBits >= 332 ? 1e100 : Math.max(1, 2 ** entropyBits)

  return {
    value: score,
    flags,
    entropyBits: Math.round(entropyBits * 10) / 10,
    estimatedGuesses,
  }
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
  const estimated = estimatePasswordGuessability(entry.password, entry)
  const flags = reused ? ['reused', ...estimated.flags] : estimated.flags
  const value = reused ? Math.min(35, estimated.value) : estimated.value
  const details = { ...estimated, value, flags }

  if (reused) return { label: 'Reused', tone: 'danger', ...details }
  if (value < 35) return { label: 'Weak', tone: 'danger', ...details }
  if (value < PASSWORD_RISK_SCORE) return { label: 'Fair', tone: 'warn', ...details }
  if (value < 90) return { label: 'Strong', tone: 'good', ...details }
  return { label: 'Excellent', tone: 'good', ...details }
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
  if (flags.has('repeated-word')) return ['Repeats the same word', 'Repeated word']
  if (flags.has('repeat')) return ['Contains a repeated pattern', 'Repeated pattern']
  if (flags.has('name')) return ['Contains a common name', 'Common name']
  if (flags.has('leet')) return ['Uses a predictable leetspeak substitution', 'Predictable leetspeak']
  if (flags.has('word-number')) return ['Combines a word with a predictable number', 'Word + number']
  if (flags.has('dictionary')) return ['Contains a predictable dictionary word', 'Dictionary word']
  if (flags.has('short')) return ['Too short to resist guessing well', 'Too short']
  if (flags.has('date')) return ['Contains a predictable year or date', 'Predictable date']
  if (flags.has('affix')) return ['Uses a common prefix or suffix', 'Common affix']
  return [`About ${health.entropyBits} bits of estimated guess resistance`, `${health.value}% strength`]
}

export function passwordRisk(entry, passwordCounts, now = Date.now()) {
  const health = passwordHealth(entry, passwordCounts)
  const ageDays = passwordAgeDays(entry, now)
  const lowStrength = health.value < PASSWORD_RISK_SCORE
  const reused = health.flags?.includes('reused') || false
  const riskFlags = new Set(['common', 'context', 'sequence', 'repeat', 'repeated-word', 'dictionary', 'name', 'leet', 'word-number', 'short'])
  const predictable = health.flags?.some((flag) => riskFlags.has(flag)) || false
  const atRisk = lowStrength || reused || predictable
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
    stale: false,
    tone: atRisk ? (health.value < 35 || reused ? 'danger' : 'warn') : health.tone,
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

export { estimatePasswordGuessability }
