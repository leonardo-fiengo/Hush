const endpoint = process.env.HUSH_CDP_ENDPOINT || 'http://127.0.0.1:9333/json/list'
const targets = await fetch(endpoint).then((response) => response.json())
const pageTarget = targets.find((candidate) => candidate.url?.endsWith('/vault.html'))
if (!pageTarget?.webSocketDebuggerUrl) throw new Error('The Hush extension dashboard target is not open.')

const socket = new WebSocket(pageTarget.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (!message.id || !pending.has(message.id)) return
  pending.get(message.id)(message)
  pending.delete(message.id)
})

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = nextId
    nextId += 1
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function extensionMessage(payload) {
  const expression = `(async () => await new Promise((resolve) => chrome.runtime.sendMessage(${JSON.stringify(payload)}, resolve)))()`
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  return response.result?.result?.value
}

await send('Runtime.enable')
const initial = await extensionMessage({ action: 'status' })
if (!initial?.ok || initial.hasVault) throw new Error('The isolated extension profile is not empty.')

let cleanupNeeded = false
try {
  const created = await extensionMessage({
    action: 'create-vault',
    password: 'Synthetic Session Granite Meadow Compass 74',
    payload: {
      schemaVersion: 2,
      items: [{ id: 'synthetic-session-check', name: 'Synthetic test', username: 'you', password: 'not-a-real-secret' }],
      preferences: { autoLockMinutes: 15, clipboardClearSeconds: 30, passwordHistoryLimit: 5 },
    },
  })
  if (!created?.ok) throw new Error(created?.error || 'Could not create the synthetic QA vault.')
  cleanupNeeded = true

  const workerTargets = await fetch(endpoint).then((response) => response.json())
  const worker = workerTargets.find((candidate) => candidate.type === 'service_worker' && candidate.url?.includes(chromeExtensionId(pageTarget.url)))
  if (!worker) throw new Error('The Hush service-worker target was not found.')
  const closeEndpoint = new URL(`/json/close/${worker.id}`, endpoint)
  const closeResponse = await fetch(closeEndpoint, { method: 'PUT' })
  if (!closeResponse.ok) throw new Error('Edge did not terminate the Hush service worker for the restart check.')
  await new Promise((resolve) => setTimeout(resolve, 1_000))

  const resumed = await extensionMessage({ action: 'status' })
  if (!resumed?.ok || !resumed.unlocked || resumed.itemCount !== 1) throw new Error('The unlocked session did not survive service-worker recreation.')
  const locked = await extensionMessage({ action: 'lock' })
  const afterLock = await extensionMessage({ action: 'status' })
  if (!locked?.ok || afterLock?.unlocked) throw new Error('Explicit lock did not remove the browser session.')
  process.stdout.write(`${JSON.stringify({ created: true, workerTerminated: true, resumedUnlocked: true, explicitLockClearedSession: true, itemCount: resumed.itemCount })}\n`)
} finally {
  if (cleanupNeeded) await extensionMessage({ action: 'delete-vault' })
  socket.close()
}

function chromeExtensionId(urlValue) {
  return new URL(urlValue).host
}
