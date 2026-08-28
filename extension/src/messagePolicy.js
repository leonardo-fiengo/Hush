export const CONTENT_ACTIONS = new Set([
  'request-credentials',
  'fill-credential',
  'generate-password',
  'stage-credential',
  'page-ready',
  'save-pending',
  'discard-pending',
])

export const EXTENSION_ACTIONS = new Set([
  'status',
  'unlock',
  'lock',
  'create-vault',
  'import-vault',
  'export-vault',
  'update-settings',
  'register-site',
  'list-sites',
  'remove-site',
])

export function classifyMessageSender(sender, { extensionId, extensionOrigin }) {
  if (sender?.id !== extensionId || !sender.url) return { kind: 'invalid' }
  let senderUrl
  try {
    senderUrl = new URL(sender.url)
  } catch {
    return { kind: 'invalid' }
  }
  let expectedExtensionUrl
  try {
    expectedExtensionUrl = new URL(extensionOrigin)
  } catch {
    return { kind: 'invalid' }
  }
  if (senderUrl.protocol === expectedExtensionUrl.protocol && senderUrl.host === expectedExtensionUrl.host) return { kind: 'extension', url: senderUrl }
  if (!sender.tab?.url || sender.frameId !== 0 || !['https:', 'http:'].includes(senderUrl.protocol)) return { kind: 'invalid' }
  let tabUrl
  try {
    tabUrl = new URL(sender.tab.url)
  } catch {
    return { kind: 'invalid' }
  }
  if (tabUrl.origin !== senderUrl.origin) return { kind: 'invalid' }
  if (sender.origin && sender.origin !== senderUrl.origin) return { kind: 'invalid' }
  return { kind: 'content', url: senderUrl, tabId: sender.tab.id }
}

export function actionAllowed(kind, action) {
  if (typeof action !== 'string') return false
  return kind === 'content' ? CONTENT_ACTIONS.has(action) : kind === 'extension' ? EXTENSION_ACTIONS.has(action) : false
}
