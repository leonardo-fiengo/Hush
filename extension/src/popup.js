import { masterPasswordHealth } from '../../src/lib/passwordRisk.js'

const app = document.querySelector('#app')
let selectedArchive = ''
const HUSH_WEB_URL = 'https://hush-password-manager.vercel.app/'

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
  if (!tab?.id || !tab.url) return null
  try {
    const url = new URL(tab.url)
    return url.protocol === 'https:' ? { tab, url } : null
  } catch {
    return null
  }
}

async function renderUnlocked(state) {
  app.replaceChildren()
  const status = element('div', { className: 'status-note' })
  const site = await currentSite()
  const summary = site ? await message({ action: 'page-summary', tabId: site.tab.id }) : null
  const openButton = element('button', { className: 'primary', text: 'Open Hush', onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL('vault.html') }) })
  const lockButton = element('button', { className: 'secondary', text: 'Lock', onclick: async () => { await message({ action: 'lock' }); await render() } })
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
  const settingsButton = element('button', { className: 'text-button', text: 'Autofill & security settings', onclick: () => chrome.runtime.openOptionsPage() })
  const pageFacts = site ? element('div', { className: 'page-facts' },
    element('span', {}, element('small', { text: 'THIS PAGE' }), element('strong', { text: site.url.hostname })),
    element('span', {}, element('small', { text: 'MATCHING LOGINS' }), element('strong', { text: summary?.ok ? String(summary.matchCount) : '\u2014' })),
  ) : null
  app.append(
    brand(),
    element('section', { className: 'card' },
      element('p', { className: 'eyebrow', text: 'VAULT UNLOCKED' }),
      element('h1', { text: `${state.itemCount} encrypted ${state.itemCount === 1 ? 'item' : 'items'}` }),
      element('p', { className: 'copy', text: 'Hush automatically offers matching logins on HTTPS forms. The service worker verifies the live tab before every fill.' }),
      pageFacts,
      openButton,
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

function renderCreateOrImport(state) {
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
  const importButton = element('button', { className: 'secondary', text: state.externalArchiveWaiting ? 'Authenticate staged web vault' : 'Choose a .hush backup first', onclick: async () => {
    const response = await message({ action: 'import-vault', archive: selectedArchive, password: importPassword.value })
    importPassword.value = ''
    selectedArchive = ''
    if (!response.ok) status.replaceChildren(errorNode(response.error))
    else await render()
  } })
  importButton.disabled = !state.externalArchiveWaiting
  const migrateButton = element('button', { className: 'text-button', text: 'Move an existing Hush web vault', onclick: () => chrome.tabs.create({ url: `${HUSH_WEB_URL}?extension=${encodeURIComponent(chrome.runtime.id)}&migrate=1` }) })
  app.append(brand(), element('section', { className: 'card' }, element('p', { className: 'eyebrow', text: state.externalArchiveWaiting ? 'ENCRYPTED WEB VAULT READY' : 'LOCAL EXTENSION VAULT' }), element('h1', { text: 'Start privately.' }), element('p', { className: 'copy', text: state.externalArchiveWaiting ? 'Enter the web vault master password here. The website never receives it.' : 'The extension owns its encrypted local vault. Create a blank vault or authenticate an encrypted Hush backup before it is stored.' }), element('label', { className: 'field' }, element('span', { text: 'New master password' }), password), element('label', { className: 'field' }, element('span', { text: 'Confirm password' }), confirmation), create, element('div', { className: 'divider', text: 'OR RESTORE' }), element('label', { className: 'file' }, element('span', { text: 'Choose .hush file' }), file), element('label', { className: 'field' }, element('span', { text: 'Backup password' }), importPassword), importButton, migrateButton, status))
}

function renderLocked(state) {
  app.replaceChildren()
  const password = element('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Master password', autofocus: '' })
  const status = element('div', { className: 'status-note' })
  const unlock = element('button', { className: 'primary', text: 'Unlock', onclick: async () => {
    unlock.disabled = true
    const response = await message({ action: 'unlock', password: password.value })
    password.value = ''
    if (!response.ok) {
      unlock.disabled = false
      status.replaceChildren(errorNode(response.error))
    } else await render()
  } })
  password.addEventListener('keydown', (event) => { if (event.key === 'Enter') unlock.click() })
  app.append(brand(), element('section', { className: 'card' }, element('p', { className: 'eyebrow', text: state.externalArchiveWaiting ? 'ENCRYPTED VAULT WAITING' : 'VAULT SEALED' }), element('h1', { text: 'Hush is locked.' }), element('p', { className: 'copy', text: 'Unlock locally to show and fill website suggestions. The session key is removed on lock, timeout, extension reload, or browser restart.' }), element('label', { className: 'field' }, element('span', { text: 'Master password' }), password), unlock, status))
  password.focus()
}

async function render() {
  const state = await message({ action: 'status' })
  if (!state.ok) return app.replaceChildren(errorNode(state.error))
  if (!state.hasVault) renderCreateOrImport(state)
  else if (!state.unlocked) renderLocked(state)
  else await renderUnlocked(state)
}

void render()
