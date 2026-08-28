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
  if (!exactHost && !explicitlyRelated) return { match: false, reason: 'The exact saved hostname and port do not match this page.' }
  if (saved.protocol === 'https:' && page.protocol !== 'https:') {
    return {
      match: true,
      fillable: false,
      reason: 'The saved HTTPS credential will not be filled into an unencrypted HTTP page.',
      page,
      saved,
    }
  }
  return {
    match: true,
    fillable: page.protocol === 'https:' && !page.isIdn,
    requiresConfirmation: page.protocol !== 'https:' || page.isIdn || explicitlyRelated,
    reason: explicitlyRelated ? 'This hostname was explicitly approved for the saved credential.' : 'Exact hostname and port match.',
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

