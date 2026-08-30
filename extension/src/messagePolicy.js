export const CONTENT_ACTIONS = new Set([
  'request-unlock',
  'request-credentials',
  'fill-credential',
  'generate-password',
  'stage-credential',
  'page-ready',
  'save-pending',
  'discard-pending',
  'undo-auto-update',
  'stage-login-step',
])

export const EXTENSION_ACTIONS = new Set([
  'status',
  'unlock',
  'lock',
  'touch-session',
  'resume-vault',
  'read-envelope',
  'create-vault',
  'import-vault',
  'export-vault',
  'replace-payload',
  'authenticate-envelope',
  'install-envelope',
  'restore-envelope',
  'open-with-session',
  'apply-envelope',
  'change-master-password',
  'recover-vault',
  'delete-vault',
  'update-settings',
  'page-summary',
])

export const EXTERNAL_ACTIONS = new Set([
  'hush-status',
  'open-manager',
  'open-import',
  'stage-encrypted-vault',
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
  if (!sender.tab?.url || sender.frameId !== 0 || senderUrl.protocol !== 'https:') return { kind: 'invalid' }
  let tabUrl
  try {
    tabUrl = new URL(sender.tab.url)
  } catch {
    return { kind: 'invalid' }
  }
  if (tabUrl.origin !== senderUrl.origin) return { kind: 'invalid' }
  if (sender.origin && sender.origin !== senderUrl.origin) return { kind: 'invalid' }
  return { kind: 'content', url: senderUrl, tabId: sender.tab.id, windowId: sender.tab.windowId }
}

export function actionAllowed(kind, action) {
  if (typeof action !== 'string') return false
  return kind === 'content' ? CONTENT_ACTIONS.has(action) : kind === 'extension' ? EXTENSION_ACTIONS.has(action) : false
}

export function externalActionAllowed(action) {
  return typeof action === 'string' && EXTERNAL_ACTIONS.has(action)
}
