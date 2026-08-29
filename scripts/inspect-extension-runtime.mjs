const endpoint = process.env.HUSH_CDP_ENDPOINT || 'http://127.0.0.1:9333/json/list'
const targets = await fetch(endpoint).then((response) => response.json())
const target = targets.find((candidate) => candidate.url?.endsWith('/vault.html'))
if (!target?.webSocketDebuggerUrl) throw new Error('The Hush extension dashboard target is not open.')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
const runtimeErrors = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
    return
  }
  if (message.method === 'Runtime.exceptionThrown' || message.method === 'Log.entryAdded') runtimeErrors.push(message)
})

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = nextId
    nextId += 1
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await send('Page.reload', { ignoreCache: true })
runtimeErrors.length = 0
await new Promise((resolve) => setTimeout(resolve, 3_000))

const evaluation = await send('Runtime.evaluate', {
  expression: '(async () => ({ text: document.body.innerText.slice(0, 600), rootChildren: document.querySelector("#root")?.childElementCount || 0, ready: document.readyState, scripts: [...document.scripts].map((script) => script.src), extensionStatus: await new Promise((resolve) => chrome.runtime.sendMessage({ action: "status" }, resolve)) }))()',
  awaitPromise: true,
  returnByValue: true,
})
socket.close()

const page = evaluation.result?.result?.value
process.stdout.write(`${JSON.stringify({ page, runtimeErrors }, null, 2)}\n`)
if (!page?.rootChildren || !page.text?.trim() || !page.extensionStatus?.ok || runtimeErrors.length) process.exitCode = 1
