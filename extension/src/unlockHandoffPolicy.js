export const UNLOCK_HANDOFF_TTL = 2 * 60_000

export function createUnlockHandoff({ requestId, tabId, windowId, pageUrl, createdAt = Date.now() } = {}) {
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{16,200}$/u.test(requestId)) throw new Error('Invalid unlock request.')
  if (!Number.isInteger(tabId) || tabId < 0 || !Number.isInteger(windowId) || windowId < 0) throw new Error('Invalid unlock request context.')
  let page
  try {
    page = new URL(pageUrl)
  } catch {
    throw new Error('Invalid unlock page.')
  }
  if (page.protocol !== 'https:') throw new Error('Hush unlock handoff is available only on HTTPS pages.')
  return {
    version: 1,
    requestId,
    tabId,
    windowId,
    origin: page.origin,
    hostname: page.hostname,
    createdAt,
  }
}

export function unlockHandoffIsValid(record, now = Date.now()) {
  return Boolean(record
    && record.version === 1
    && typeof record.requestId === 'string'
    && /^[a-zA-Z0-9-]{16,200}$/u.test(record.requestId)
    && Number.isInteger(record.tabId)
    && record.tabId >= 0
    && Number.isInteger(record.windowId)
    && record.windowId >= 0
    && typeof record.origin === 'string'
    && record.origin.startsWith('https://')
    && typeof record.hostname === 'string'
    && record.hostname.length > 0
    && Number.isFinite(record.createdAt)
    && now >= record.createdAt
    && now - record.createdAt <= UNLOCK_HANDOFF_TTL)
}

export function unlockHandoffMatchesTab(record, tab, now = Date.now()) {
  if (!unlockHandoffIsValid(record, now) || tab?.id !== record.tabId || tab?.windowId !== record.windowId || typeof tab.url !== 'string') return false
  try {
    return new URL(tab.url).origin === record.origin
  } catch {
    return false
  }
}
