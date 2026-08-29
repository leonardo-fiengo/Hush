import { parse as parseDomain } from 'tldts'

const WEB_SCHEMES = new Set(['https:', 'http:'])

function parseWebUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid website URL.')
  }
  if (!WEB_SCHEMES.has(url.protocol) || url.username || url.password) throw new Error('Only normal HTTP or HTTPS website URLs are supported.')
  const domain = parseDomain(url.hostname, {
    extractHostname: false,
    allowPrivateDomains: true,
    detectSpecialUse: true,
  })
  if (!domain.hostname) throw new Error('Invalid website hostname.')
  return {
    url,
    hostname: url.hostname,
    host: url.host,
    origin: url.origin,
    protocol: url.protocol,
    port: url.port,
    registrableDomain: domain.domain,
    publicSuffix: domain.publicSuffix,
    isIp: Boolean(domain.isIp),
    isIcann: Boolean(domain.isIcann),
    isPrivateSuffix: Boolean(domain.isPrivate),
    isIdn: url.hostname.split('.').some((label) => label.startsWith('xn--')),
    isSpecialUse: Boolean(domain.isSpecialUse),
  }
}

function normalizedAllowedHosts(entry) {
  if (!Array.isArray(entry?.allowedHosts)) return []
  return entry.allowedHosts.flatMap((value) => {
    try {
      return [parseWebUrl(/^https?:\/\//iu.test(value) ? value : `https://${value}`).host]
    } catch {
      return []
    }
  })
}

export function describePageUrl(value) {
  const parsed = parseWebUrl(value)
  const warnings = []
  if (parsed.protocol !== 'https:') warnings.push('This page uses unencrypted HTTP.')
  if (parsed.isIdn) warnings.push('This page uses an internationalized hostname. Verify it carefully before filling.')
  if (!parsed.registrableDomain && !parsed.isIp && !parsed.isSpecialUse) warnings.push('This hostname has no recognized registrable domain.')
  return { ...parsed, warnings }
}

export function matchCredentialToPage(entry, pageUrl) {
  if (!entry?.url) return { match: false, reason: 'Credential has no saved website.' }
  let saved
  let page
  try {
    saved = parseWebUrl(/^https?:\/\//iu.test(entry.url) ? entry.url : `https://${entry.url}`)
    page = describePageUrl(pageUrl)
  } catch (error) {
    return { match: false, reason: error.message }
  }

  const exactHost = saved.host === page.host
  const explicitlyRelated = normalizedAllowedHosts(entry).includes(page.host)
  const sameSite = !exactHost
    && !explicitlyRelated
    && saved.hostname !== page.hostname
    && !saved.port
    && !page.port
    && saved.protocol === 'https:'
    && page.protocol === 'https:'
    && !saved.isIp
    && !page.isIp
    && !(saved.isSpecialUse && !saved.isIcann)
    && !(page.isSpecialUse && !page.isIcann)
    && !saved.isIdn
    && !page.isIdn
    && Boolean(saved.registrableDomain)
    && saved.registrableDomain === page.registrableDomain
  const matchType = exactHost ? 'exact' : explicitlyRelated ? 'allowed-host' : sameSite ? 'same-site' : ''
  if (!matchType) return { match: false, reason: 'The saved website is not safely related to this hostname and port.' }
  if (page.protocol !== 'https:') {
    return {
      match: true,
      fillable: false,
      matchType,
      autoFillSafe: false,
      requiresConfirmation: true,
      reason: saved.protocol === 'https:'
        ? 'The saved HTTPS credential will not be filled into an unencrypted HTTP page.'
        : 'Hush does not fill credentials into unencrypted HTTP pages.',
      page,
      saved,
    }
  }
  const unusualPort = Boolean(saved.port || page.port)
  const protocolUpgrade = saved.protocol !== page.protocol
  const suspiciousExactHost = saved.isIp || page.isIp || (saved.isSpecialUse && !saved.isIcann) || (page.isSpecialUse && !page.isIcann) || unusualPort
  const requiresConfirmation = page.isIdn || matchType !== 'exact' || suspiciousExactHost || protocolUpgrade
  let reason = 'Exact hostname and port match.'
  if (matchType === 'same-site') reason = `Same registrable website (${page.registrableDomain}); confirm this subdomain before filling.`
  else if (matchType === 'allowed-host') reason = 'This hostname was explicitly approved for the saved credential.'
  else if (suspiciousExactHost) reason = 'Exact hostname match on an unusual port, IP address, or special-use host; verify it before filling.'
  else if (protocolUpgrade) reason = 'The saved HTTP login matches this HTTPS hostname; verify it before filling.'
  return {
    match: true,
    fillable: page.protocol === 'https:' && !page.isIdn,
    matchType,
    autoFillSafe: matchType === 'exact' && saved.protocol === 'https:' && page.protocol === 'https:' && !page.isIdn && !suspiciousExactHost,
    requiresConfirmation,
    reason,
    page,
    saved,
  }
}

export function credentialsForPage(entries, pageUrl) {
  return entries.flatMap((entry) => {
    const result = matchCredentialToPage(entry, pageUrl)
    return result.match ? [{ entry, match: result }] : []
  })
}
