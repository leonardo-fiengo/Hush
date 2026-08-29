const EXTENSION_ID_PATTERN = /^[a-p]{32}$/u
const SAVED_EXTENSION_ID_KEY = 'hush-authoritative-extension-id'

function validExtensionId(value) {
  return typeof value === 'string' && EXTENSION_ID_PATTERN.test(value) ? value : ''
}

export function configuredExtensionId() {
  const queryId = validExtensionId(new URLSearchParams(window.location.search).get('extension'))
  if (queryId) {
    window.localStorage.setItem(SAVED_EXTENSION_ID_KEY, queryId)
    return queryId
  }
  return validExtensionId(import.meta.env.VITE_HUSH_EXTENSION_ID)
    || validExtensionId(window.localStorage.getItem(SAVED_EXTENSION_ID_KEY))
}

export function sendExtensionMessage(extensionId, payload, timeoutMs = 2_000) {
  const runtime = globalThis.chrome?.runtime
  if (!validExtensionId(extensionId) || !runtime?.sendMessage) return Promise.reject(new Error('The Hush extension bridge is not configured.'))
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('The Hush extension did not respond.'))
    }, timeoutMs)
    try {
      runtime.sendMessage(extensionId, payload, (response) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        if (runtime.lastError) reject(new Error(runtime.lastError.message))
        else if (!response?.ok) reject(new Error(response?.error || 'The Hush extension rejected that request.'))
        else resolve(response)
      })
    } catch (error) {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      reject(error)
    }
  })
}

export async function detectExtensionAuthority() {
  const extensionId = configuredExtensionId()
  if (!extensionId) return null
  try {
    const status = await sendExtensionMessage(extensionId, { action: 'hush-status' })
    return { extensionId, status }
  } catch {
    return null
  }
}
