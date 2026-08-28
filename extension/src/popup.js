import { masterPasswordHealth } from '../../src/lib/passwordRisk.js'

const app = document.querySelector('#app')
let selectedArchive = ''

function message(payload) {
  return new Promise((resolve) => chrome.runtime.sendMessage(payload, (response) => {
    if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message })
    else resolve(response || { ok: false, error: 'Hush did not respond.' })
  }))
}

function element(tag, options = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(options)) {
    if (key === 'className') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (value !== undefined) node.setAttribute(key, value)
  }
  node.append(...children.filter(Boolean))
  return node
}

function brand() {
  return element('header', { className: 'brand' }, element('span', { className: 'mark', text: 'H' }), element('div', {}, element('strong', { text: 'hush.' }), element('small', { text: 'PRIVATE VAULT' })))
}

function errorNode(text) {
  return element('p', { className: 'error', role: 'alert', text })
}

async function currentSite() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.url || !['http:', 'https:'].includes(new URL(tab.url).protocol)) return null
  const url = new URL(tab.url)
  return { tab, url, pattern: `${url.protocol}//${url.hostname}/*` }
}

async function enableCurrentSite(button, status) {
  const site = await currentSite()
  if (!site) return
  const granted = await chrome.permissions.request({ origins: [site.pattern] })
  if (!granted) {
    status.replaceChildren(errorNode('Site access was not granted.'))
    return
  }
  const response = await message({ action: 'register-site', tabId: site.tab.id, url: site.tab.url })
  if (!response.ok) status.replaceChildren(errorNode(response.error))
  else {
    button.disabled = true
    button.textContent = `Enabled on ${site.url.hostname}`
    status.textContent = 'Reloading is not required. Focus a login field to see the Hush button.'
  }
}

async function renderUnlocked(state) {
  app.replaceChildren()
  const status = element('div', { className: 'status-note' })
  const site = await currentSite()
  let accessButton = null
  if (site) {
    const enabled = await chrome.permissions.contains({ origins: [site.pattern] })
    accessButton = element('button', {
      className: 'primary',
      text: enabled ? `Enabled on ${site.url.hostname}` : `Enable on ${site.url.hostname}`,
      onclick: () => { void enableCurrentSite(accessButton, status) },
    })
    accessButton.disabled = enabled
  }
  const lockButton = element('button', { className: 'secondary', text: 'Lock now', onclick: async () => { await message({ action: 'lock' }); await render() } })
  const exportButton = element('button', { className: 'text-button', text: 'Download encrypted backup', onclick: async () => {
    const response = await message({ action: 'export-vault' })
    if (!response.ok) return status.replaceChildren(errorNode(response.error))
    const url = URL.createObjectURL(new Blob([response.archive], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `hush-extension-backup-${new Date().toISOString().slice(0, 10)}.hush`
    link.click()
    URL.revokeObjectURL(url)
  } })
  const settingsButton = element('button', { className: 'text-button', text: 'Permissions & settings', onclick: () => chrome.runtime.openOptionsPage() })
  app.append(
    brand(),
    element('section', { className: 'card' },
      element('p', { className: 'eyebrow', text: 'VAULT UNLOCKED' }),
      element('h1', { text: `${state.itemCount} encrypted ${state.itemCount === 1 ? 'item' : 'items'}` }),
      element('p', { className: 'copy', text: 'Hush fills only after you click its field button and only on an exact approved hostname.' }),
      accessButton,
      lockButton,
      exportButton,
      settingsButton,
      status,
    ),
  )
}

function renderRecoveryKey(recoveryKey) {
  app.replaceChildren()
  const confirmed = element('input', { type: 'checkbox' })
  const continueButton = element('button', { className: 'primary', text: 'I saved it · continue', onclick: () => { void render() } })
  continueButton.disabled = true
  confirmed.addEventListener('change', () => { continueButton.disabled = !confirmed.checked })
  const copyButton = element('button', { className: 'secondary', text: 'Copy recovery key', onclick: async () => {
    await navigator.clipboard.writeText(recoveryKey)
    copyButton.textContent = 'Copied · clear your clipboard after saving'
  } })
  app.append(brand(), element('section', { className: 'card' }, element('p', { className: 'eyebrow', text: 'ONE-TIME RECOVERY KEY' }), element('h1', { text: 'Save this offline.' }), element('p', { className: 'copy', text: 'Hush will never show it again. Anyone with this key and your encrypted vault can recover the vault.' }), element('code', { className: 'recovery', text: recoveryKey }), copyButton, element('label', { className: 'confirm' }, confirmed, element('span', { text: 'I saved the recovery key' })), continueButton))
}

function renderCreateOrImport() {
  app.replaceChildren()
  const password = element('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Long master passphrase' })
  const confirmation = element('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Confirm passphrase' })
  const status = element('div', { className: 'status-note' })
  const create = element('button', { className: 'primary', text: 'Create encrypted extension vault', onclick: async () => {
    const health = masterPasswordHealth(password.value)
    if (!health.acceptable) return status.replaceChildren(errorNode('Use at least 14 characters and avoid predictable words, names, sequences, and dates.'))
    if (password.value !== confirmation.value) return status.replaceChildren(errorNode('The passwords do not match.'))
    create.disabled = true
    const response = await message({ action: 'create-vault', password: password.value })
    password.value = ''
    confirmation.value = ''
    if (!response.ok) {
      create.disabled = false
      status.replaceChildren(errorNode(response.error))
    } else renderRecoveryKey(response.recoveryKey)
  } })
  const file = element('input', { type: 'file', accept: '.hush,application/json' })
  file.addEventListener('change', async () => {
    const selected = file.files?.[0]
    if (!selected || selected.size > 50 * 1024 * 1024) return status.replaceChildren(errorNode('Choose a Hush backup smaller than 50 MB.'))
    selectedArchive = await selected.text()
    importButton.disabled = false
    importButton.textContent = `Authenticate ${selected.name}`
  })
  const importPassword = element('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Backup master password' })
  const importButton = element('button', { className: 'secondary', text: 'Choose a .hush backup first', onclick: async () => {
    const response = await message({ action: 'import-vault', archive: selectedArchive, password: importPassword.value })
    importPassword.value = ''
    selectedArchive = ''
    if (!response.ok) status.replaceChildren(errorNode(response.error))
    else await render()
  } })
  importButton.disabled = true
  app.append(brand(), element('section', { className: 'card' }, element('p', { className: 'eyebrow', text: 'LOCAL EXTENSION VAULT' }), element('h1', { text: 'Start privately.' }), element('p', { className: 'copy', text: 'The extension owns its encrypted local vault. Create a blank vault or authenticate an encrypted Hush backup before it is stored.' }), element('label', { className: 'field' }, element('span', { text: 'New master password' }), password), element('label', { className: 'field' }, element('span', { text: 'Confirm password' }), confirmation), create, element('div', { className: 'divider', text: 'OR RESTORE' }), element('label', { className: 'file' }, element('span', { text: 'Choose .hush file' }), file), element('label', { className: 'field' }, element('span', { text: 'Backup password' }), importPassword), importButton, status))
}

function renderLocked(state) {
  app.replaceChildren()
  const password = element('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Master password', autofocus: '' })
  const status = element('div', { className: 'status-note' })
  const unlock = element('button', { className: 'primary', text: 'Unlock locally', onclick: async () => {
    unlock.disabled = true
    const response = await message({ action: 'unlock', password: password.value })
    password.value = ''
    if (!response.ok) {
      unlock.disabled = false
      status.replaceChildren(errorNode(response.error))
    } else await render()
  } })
  password.addEventListener('keydown', (event) => { if (event.key === 'Enter') unlock.click() })
  app.append(brand(), element('section', { className: 'card' }, element('p', { className: 'eyebrow', text: state.externalArchiveWaiting ? 'ENCRYPTED VAULT WAITING' : 'VAULT SEALED' }), element('h1', { text: 'Welcome back.' }), element('p', { className: 'copy', text: 'The usable vault key exists only in extension memory until Hush locks or the browser restarts.' }), element('label', { className: 'field' }, element('span', { text: 'Master password' }), password), unlock, status))
  password.focus()
}

async function render() {
  const state = await message({ action: 'status' })
  if (!state.ok) return app.replaceChildren(errorNode(state.error))
  if (!state.hasVault) renderCreateOrImport()
  else if (!state.unlocked) renderLocked(state)
  else await renderUnlocked(state)
}

void render()

