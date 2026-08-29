const app = document.querySelector('#app')

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
    else node.setAttribute(key, value)
  }
  node.append(...children.filter(Boolean))
  return node
}

async function render() {
  const status = await message({ action: 'status' })
  app.replaceChildren()
  const notice = element('div', { className: 'status-note' })
  const header = element('header', { className: 'options-header' }, element('span', { className: 'mark', text: 'H' }), element('div', {}, element('p', { className: 'eyebrow', text: 'HUSH EXTENSION' }), element('h1', { text: 'Autofill & locking' }), element('p', { className: 'copy', text: 'Hush runs on normal HTTPS pages, never HTTP, and does not request browsing-history access.' })))
  const settingsCard = element('section', { className: 'options-card' }, element('h2', { text: 'Unlocked-vault settings' }))
  if (!status.unlocked) settingsCard.append(element('p', { className: 'copy', text: 'Unlock the extension from its toolbar popup to change encrypted settings.' }))
  else {
    const autoLock = element('select')
    for (const [value, label] of [[5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [0, 'Never']]) autoLock.append(element('option', { value, text: label }))
    autoLock.value = String(status.preferences.autoLockMinutes)
    const history = element('select')
    for (const [value, label] of [[0, 'Off'], [3, '3 versions'], [5, '5 versions'], [10, '10 versions']]) history.append(element('option', { value, text: label }))
    history.value = String(status.preferences.passwordHistoryLimit)
    const autofill = element('input', { type: 'checkbox' })
    autofill.checked = status.preferences.autofillSingleExact === true
    const save = element('button', { className: 'primary', text: 'Encrypt & save settings', onclick: async () => {
      const response = await message({ action: 'update-settings', settings: { autoLockMinutes: Number(autoLock.value), passwordHistoryLimit: Number(history.value), autofillSingleExact: autofill.checked } })
      notice.textContent = response.ok ? 'Settings encrypted and saved.' : response.error
    } })
    settingsCard.append(element('label', { className: 'setting' }, element('span', { text: 'Lock after inactivity' }), autoLock), element('label', { className: 'setting' }, element('span', { text: 'Encrypted password history' }), history), element('label', { className: 'setting' }, element('span', {}, element('strong', { text: 'Autofill a single exact login match automatically' }), element('small', { text: 'Never selects among multiple accounts or fills same-site, IDN, registration, or new-password fields.' })), autofill), save, notice)
  }
  const permissionExplanation = element('section', { className: 'options-card' }, element('h2', { text: 'Why these permissions?' }), element('dl', { className: 'permission-list' }, element('dt', { text: 'https://*/*' }), element('dd', { text: 'Detects login forms and presents suggestions on HTTPS sites. Hush excludes its hosted web app and never runs on HTTP.' }), element('dt', { text: 'storage' }), element('dd', { text: 'Stores only the authenticated encrypted vault envelope and trusted session material.' }), element('dt', { text: 'idle' }), element('dd', { text: 'Locks usable keys when the device becomes locked.' })))
  app.append(header, settingsCard, permissionExplanation)
}

void render()
