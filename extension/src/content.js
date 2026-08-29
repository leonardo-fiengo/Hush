import { classifyFormSignals, inputDescriptor } from './formDetection.js'

if (!globalThis.__hushContentLoaded) {
  globalThis.__hushContentLoaded = true

  const observedFields = new WeakSet()
  const observedRoots = new WeakSet()
  let activeContext = null
  let scanTimer = null
  let requestSerial = 0
  let stagedUsername = ''
  let lastPageUrl = location.href
  const stagedSubmissions = new WeakMap()
  const watchedSubmissions = new WeakSet()
  const mutationObserver = new MutationObserver(() => scheduleScan())

  const host = document.createElement('div')
  host.setAttribute('aria-label', 'Hush password manager')
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = `
    :host { all: initial; position: fixed; z-index: 2147483647; font-family: system-ui, sans-serif; color-scheme: light; }
    button { font: inherit; }
    .trigger { display: grid; place-items: center; width: 26px; height: 26px; padding: 0; color: #56602f; border: 1px solid #d4dac0; border-radius: 9px; background: #f3f7e5; box-shadow: 0 3px 10px rgba(20,24,15,.12); cursor: pointer; opacity: .9; transition: background .15s ease, box-shadow .15s ease, opacity .15s ease; }
    .trigger:hover, .trigger:focus-visible { background: #e8f5b8; box-shadow: 0 4px 14px rgba(20,24,15,.16); opacity: 1; outline: none; }
    .trigger strong { font: 750 12px/1 Georgia, serif; }
    .panel { position: absolute; top: 32px; right: 0; width: 284px; max-height: min(390px, calc(100vh - 48px)); overflow: auto; color: #292c26; border: 1px solid rgba(203,207,194,.9); border-radius: 16px; background: rgba(251,252,247,.98); box-shadow: 0 10px 30px rgba(20,24,15,.16); animation: hush-in .12s ease-out; }
    @keyframes hush-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }
    :host(.above) .panel { top: auto; bottom: 34px; }
    :host(.align-left) .panel { right: auto; left: 0; }
    .head { display: flex; align-items: center; justify-content: space-between; min-height: 40px; padding: 0 12px; border-bottom: 1px solid #e7e8df; }
    .head strong { font-size: 11px; font-weight: 700; }
    .head button { padding: 4px; border: 0; background: none; cursor: pointer; }
    .site { padding: 10px 12px; color: #696c62; font: 10px/1.45 ui-monospace, monospace; }
    .choice { display: grid; width: 100%; padding: 10px 12px; text-align: left; border: 0; border-top: 1px solid #e9eae2; background: rgba(255,255,255,.72); cursor: pointer; }
    .choice:hover, .choice:focus { background: #f4f7e8; outline: none; }
    .choice strong { color: #22241f; font-size: 11px; }
    .choice span { margin-top: 3px; color: #6d7066; font-size: 9px; }
    .choice small { margin-top: 5px; color: #60701f; font-size: 8px; font-weight: 750; }
    .choice em { margin-top: 5px; color: #9a4d38; font-size: 8px; font-style: normal; }
    .empty { margin: 0; padding: 15px 12px; color: #686b61; font-size: 10px; line-height: 1.5; }
    .generate { display: flex; align-items: center; justify-content: center; width: calc(100% - 24px); min-height: 38px; margin: 12px; color: #20231d; border: 0; border-radius: 9px; background: #dfff70; font-size: 10px; font-weight: 750; cursor: pointer; }
    .save { padding: 13px; }
    .save p { margin: 0 0 10px; color: #55584f; font-size: 10px; line-height: 1.45; }
    .actions { display: flex; gap: 7px; }
    .actions button { flex: 1; min-height: 33px; border: 1px solid #d4d6cb; border-radius: 8px; background: #fff; cursor: pointer; font-size: 9px; }
    .actions .primary { border-color: #dfff70; background: #dfff70; font-weight: 750; }
  `
  const trigger = document.createElement('button')
  trigger.className = 'trigger'
  trigger.type = 'button'
  trigger.title = 'Open Hush'
  trigger.setAttribute('aria-label', 'Open Hush for this field')
  const triggerText = document.createElement('strong')
  triggerText.textContent = 'H'
  trigger.append(triggerText)
  shadow.append(style, trigger)
  document.documentElement.append(host)
  host.hidden = true

  function runtimeMessage(message) {
    return new Promise((resolve) => chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message })
      else resolve(response || { ok: false, error: 'Hush did not respond.' })
    }))
  }

  function fieldVisible(field) {
    if (!field || field.disabled || field.readOnly || field.type === 'hidden') return false
    const styleValue = getComputedStyle(field)
    return styleValue.display !== 'none' && styleValue.visibility !== 'hidden' && field.getClientRects().length > 0
  }

  function rootsUnder(root = document) {
    if (!observedRoots.has(root)) {
      observedRoots.add(root)
      mutationObserver.observe(root, { childList: true, subtree: true })
    }
    const roots = [root]
    const elements = root.querySelectorAll?.('*') || []
    for (const element of elements) if (element.shadowRoot) roots.push(...rootsUnder(element.shadowRoot))
    return roots
  }

  function fieldsFor(input) {
    const root = input.form || input.getRootNode()
    const fields = [...(root.querySelectorAll?.('input') || [])].filter(fieldVisible)
    return fields.length ? fields : [input]
  }

  function focusRole(input) {
    const descriptor = inputDescriptor(input)
    const signals = `${descriptor.name} ${descriptor.label}`
    if (descriptor.type === 'password') {
      if (descriptor.autocomplete === 'current-password' || /current|old/u.test(signals)) return 'current-password'
      if (descriptor.autocomplete === 'new-password' || /new|confirm|repeat/u.test(signals)) return 'new-password'
      return 'password'
    }
    if (descriptor.autocomplete === 'username' || descriptor.type === 'email' || /user|login|email|account/u.test(signals)) return 'username'
    return 'unknown'
  }

  function buildContext(input) {
    const fields = fieldsFor(input)
    const container = input.form || input.closest?.('[role="form"]') || input.parentElement
    const analysis = classifyFormSignals({
      fields: fields.map(inputDescriptor),
      text: container?.textContent?.slice(0, 2000) || '',
      path: location.pathname,
    })
    return { input, fields, analysis, focusRole: focusRole(input), pageUrl: location.href }
  }

  function formRequest(context) {
    return { formKind: context.analysis.kind, focusRole: context.focusRole }
  }

  function panelIntent(context, automatic) {
    if (context.analysis.kind === 'registration') {
      return { credentials: false, generator: !automatic || context.focusRole === 'new-password' || context.focusRole === 'password' }
    }
    if (context.analysis.kind === 'password-change') {
      const generator = context.focusRole === 'new-password'
      const credentials = context.focusRole === 'current-password' || (!automatic && !generator)
      return { credentials, generator }
    }
    return {
      credentials: context.analysis.kind === 'login' || context.analysis.kind === 'username-step',
      generator: false,
    }
  }

  function positionTrigger(input) {
    const rect = input.getBoundingClientRect()
    const left = Math.max(4, Math.min(innerWidth - 30, rect.right - 32))
    host.style.top = `${Math.max(4, rect.top + (rect.height - 26) / 2)}px`
    host.style.left = `${left}px`
    host.classList.toggle('above', rect.bottom + 400 > innerHeight && rect.top > 180)
    host.classList.toggle('align-left', left < 284)
    host.hidden = false
  }

  function closePanel() {
    shadow.querySelector('.panel')?.remove()
  }

  function dismissPanel() {
    requestSerial += 1
    closePanel()
  }

  function createPanel(title = 'Hush') {
    closePanel()
    const panel = document.createElement('section')
    panel.className = 'panel'
    panel.setAttribute('role', 'dialog')
    const head = document.createElement('div')
    head.className = 'head'
    const heading = document.createElement('strong')
    heading.textContent = title
    const close = document.createElement('button')
    close.type = 'button'
    close.textContent = '\u00d7'
    close.setAttribute('aria-label', 'Close Hush')
    close.addEventListener('click', dismissPanel)
    head.append(heading, close)
    panel.append(head)
    shadow.append(panel)
    return panel
  }

  function appendSite(panel) {
    const site = document.createElement('div')
    site.className = 'site'
    site.textContent = location.hostname
    panel.append(site)
  }

  function showError(message) {
    const panel = createPanel('Hush could not continue')
    const paragraph = document.createElement('p')
    paragraph.className = 'empty'
    paragraph.textContent = message
    panel.append(paragraph)
  }

  async function fillCredential(credentialId, requestId, context) {
    const response = await runtimeMessage({
      action: 'fill-credential',
      credentialId,
      requestId,
      pageUrl: context.pageUrl,
      form: formRequest(context),
    })
    if (!response?.ok) showError(response?.error || 'Hush could not fill this page.')
    else closePanel()
  }

  async function generateForContext(context) {
    const response = await runtimeMessage({ action: 'generate-password', pageUrl: context.pageUrl })
    if (!response?.ok) return showError(response?.error || 'Unlock Hush before generating a password.')
    if (location.href !== context.pageUrl || activeContext !== context || !context.input.isConnected) return showError('The page changed before Hush could use that password.')
    performFill({ password: response.password, mode: context.analysis.kind, expectedPageUrl: context.pageUrl })
    closePanel()
  }

  function panelTitle(context, intent) {
    if (intent.generator && !intent.credentials) return 'Use a strong Hush password'
    if (context.analysis.kind === 'password-change') return 'Fill current password'
    return context.analysis.kind === 'username-step' ? 'Continue with Hush' : 'Sign in with Hush'
  }

  async function openPanel({ automatic = false } = {}) {
    const context = activeContext
    if (!context || location.href !== context.pageUrl || !context.input.isConnected) return
    const intent = panelIntent(context, automatic)
    if (!intent.credentials && !intent.generator) return
    const serial = ++requestSerial
    closePanel()
    const response = await runtimeMessage({
      action: 'request-credentials',
      pageUrl: context.pageUrl,
      form: formRequest(context),
    })
    if (serial !== requestSerial || activeContext !== context || location.href !== context.pageUrl) return
    if (response?.autofilled) return closePanel()
    if (automatic && response?.ok && !intent.generator && !response.credentials?.length) return closePanel()
    const panel = createPanel(panelTitle(context, intent))
    appendSite(panel)
    if (!response?.ok) {
      const paragraph = document.createElement('p')
      paragraph.className = 'empty'
      paragraph.textContent = response?.error || 'Open the Hush extension and unlock your vault first.'
      panel.append(paragraph)
      return
    }
    if (intent.credentials && response.credentials?.length) {
      for (const credential of response.credentials) {
        const choice = document.createElement('button')
        choice.type = 'button'
        choice.className = 'choice'
        const name = document.createElement('strong')
        name.textContent = credential.name
        const username = document.createElement('span')
        username.textContent = credential.username || 'No username'
        choice.append(name, username)
        if (credential.preferred) {
          const preferred = document.createElement('small')
          preferred.textContent = 'Selected for this sign-in'
          choice.append(preferred)
        }
        if (credential.warning) {
          const warning = document.createElement('em')
          warning.textContent = credential.warning
          choice.append(warning)
        }
        choice.disabled = !credential.fillable
        choice.addEventListener('click', () => { void fillCredential(credential.id, response.requestId, context) })
        panel.append(choice)
      }
    } else if (intent.credentials) {
      const paragraph = document.createElement('p')
      paragraph.className = 'empty'
      paragraph.textContent = 'No login is saved for this website.'
      panel.append(paragraph)
    }
    if (intent.generator) {
      const generate = document.createElement('button')
      generate.type = 'button'
      generate.className = 'generate'
      generate.textContent = 'Use a strong Hush password'
      generate.addEventListener('click', () => { void generateForContext(context) })
      panel.append(generate)
    }
  }

  function setNativeValue(field, value) {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (!setter) return false
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    field.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
    return true
  }

  function performFill({ username, password, mode, expectedPageUrl }) {
    const context = activeContext
    if (!context || !context.input.isConnected || (expectedPageUrl && (location.href !== expectedPageUrl || context.pageUrl !== expectedPageUrl))) return false
    mode ||= context.analysis.kind
    const descriptors = context.fields.filter((field) => field.isConnected).map((field) => ({ field, descriptor: inputDescriptor(field) }))
    const usernameField = descriptors.find(({ descriptor }) => descriptor.autocomplete === 'username')
      || descriptors.find(({ descriptor }) => descriptor.type === 'email')
      || descriptors.find(({ descriptor }) => /user|login|email/u.test(`${descriptor.name} ${descriptor.label}`))
    const passwordFields = descriptors.filter(({ descriptor }) => descriptor.type === 'password')
    const currentField = passwordFields.find(({ descriptor }) => descriptor.autocomplete === 'current-password' || /current|old/u.test(`${descriptor.name} ${descriptor.label}`))
    const newFields = passwordFields.filter(({ descriptor }) => descriptor.autocomplete === 'new-password' || /new|confirm|repeat/u.test(`${descriptor.name} ${descriptor.label}`))
    let changed = false

    if (mode === 'username-step') {
      if (username && usernameField) changed = setNativeValue(usernameField.field, username) || changed
      if (username) stagedUsername = username
      return changed
    }
    if (mode === 'current-password') {
      if (currentField && password) changed = setNativeValue(currentField.field, password) || changed
      return changed
    }
    if ((mode === 'registration' || mode === 'password-change') && newFields.length) {
      if (password) for (const { field } of newFields) changed = setNativeValue(field, password) || changed
    } else if (password && passwordFields[0]) {
      changed = setNativeValue(passwordFields[0].field, password) || changed
    }
    if (mode === 'login' && username && usernameField) changed = setNativeValue(usernameField.field, username) || changed
    if (username) stagedUsername = username
    return changed
  }

  function usernameFieldFor(fields) {
    return fields.find((field) => inputDescriptor(field).autocomplete === 'username')
      || fields.find((field) => field.type === 'email')
      || fields.find((field) => /user|login|email/u.test(`${field.name} ${field.getAttribute('aria-label') || ''}`))
  }

  const SUBMISSION_WORDS = /\b(log\s*in|sign\s*in|register|create|join|continue|next|submit|save|update|change|reset)\b/iu
  const FAILURE_WORDS = /\b(incorrect|invalid|failed|failure|error|try again|wrong|does not match|didn't match|unable)\b/iu
  const SUCCESS_WORDS = /\b(signed in|logged in|account (?:created|ready)|password (?:changed|updated)|success|successful|successfully)\b/iu

  function visibleElement(element) {
    if (!element) return false
    const styleValue = getComputedStyle(element)
    return styleValue.display !== 'none' && styleValue.visibility !== 'hidden' && element.getClientRects().length > 0
  }

  function visibleStatusText(selector, pattern) {
    return [...document.querySelectorAll(selector)].slice(0, 100).some((element) => visibleElement(element) && pattern.test(element.textContent?.slice(0, 1000) || ''))
  }

  function pageShowsFailure() {
    return visibleStatusText('[role="alert"], [aria-live="assertive"], .error, .error-message, .field-error', FAILURE_WORDS)
  }

  function pageShowsSuccess() {
    return visibleStatusText('[role="status"], [aria-live="polite"], .success, .success-message, .notice', SUCCESS_WORDS)
  }

  function pageSuccessEvidence(container = null, beforeUrl = location.href) {
    if (pageShowsFailure()) return false
    if (location.href !== beforeUrl) return true
    const scope = container?.isConnected ? container : document
    const visiblePasswords = [...(scope.querySelectorAll?.('input[type="password"]') || [])].filter(fieldVisible)
    return Boolean((container && !container.isConnected) || !visiblePasswords.length || pageShowsSuccess())
  }

  async function requestPendingPrompt(successEvidence = false) {
    const response = await runtimeMessage({
      action: 'page-ready',
      pageUrl: location.href,
      successEvidence,
      failureEvidence: pageShowsFailure(),
    })
    if (response?.pending) showSavePrompt(response.pending)
    return response
  }

  async function probePendingPrompt() {
    for (const delay of [0, 400, 1_200]) {
      if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay))
      const response = await requestPendingPrompt(pageSuccessEvidence())
      if (response?.pending || response?.awaitingSuccess) return
    }
  }

  function watchForSuccessfulTransition(container, beforeUrl) {
    if (watchedSubmissions.has(container)) return
    watchedSubmissions.add(container)
    let checkTimer = null
    let finished = false
    const observer = new MutationObserver(() => {
      if (checkTimer || finished) return
      checkTimer = window.setTimeout(check, 120)
    })
    const timeout = window.setTimeout(cleanup, 12_000)

    function cleanup() {
      if (finished) return
      finished = true
      observer.disconnect()
      if (checkTimer) window.clearTimeout(checkTimer)
      window.clearTimeout(timeout)
      watchedSubmissions.delete(container)
    }

    function check() {
      checkTimer = null
      if (finished || !pageSuccessEvidence(container, beforeUrl)) return
      cleanup()
      void requestPendingPrompt(true)
    }

    observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'style', 'class'] })
    checkTimer = window.setTimeout(check, 500)
  }

  function stageCredentialContainer(container) {
    if (!(container instanceof Element)) return null
    const recent = stagedSubmissions.get(container)
    if (recent && Date.now() - recent.createdAt < 300) return recent.promise
    const fields = [...container.querySelectorAll('input')].filter(fieldVisible)
    const analysis = classifyFormSignals({ fields: fields.map(inputDescriptor), text: container.textContent?.slice(0, 2000), path: location.pathname })
    const usernameField = usernameFieldFor(fields)
    if (analysis.kind === 'username-step') {
      const username = String(usernameField?.value || '').slice(0, 512)
      return username ? runtimeMessage({ action: 'stage-login-step', username, pageUrl: location.href }) : null
    }
    const passwordFields = fields.filter((field) => field.type === 'password')
    const currentField = passwordFields.find((field) => {
      const descriptor = inputDescriptor(field)
      return descriptor.autocomplete === 'current-password' || /current|old/u.test(`${descriptor.name} ${descriptor.label}`)
    })
    const newFields = passwordFields.filter((field) => {
      const descriptor = inputDescriptor(field)
      return descriptor.autocomplete === 'new-password' || /new|confirm|repeat/u.test(`${descriptor.name} ${descriptor.label}`)
    })
    const password = (analysis.kind === 'registration' || analysis.kind === 'password-change') ? newFields[0]?.value || passwordFields.at(-1)?.value : passwordFields[0]?.value
    if (!password || password.length > 4096) return null
    const username = usernameField?.value || stagedUsername
    const beforeUrl = location.href
    const promise = runtimeMessage({
      action: 'stage-credential',
      pageUrl: beforeUrl,
      capture: {
        kind: analysis.kind,
        username: String(username || '').slice(0, 512),
        password,
        currentPassword: String(currentField?.value || '').slice(0, 4096),
      },
    })
    stagedSubmissions.set(container, { createdAt: Date.now(), promise })
    void promise.then((response) => {
      if (response?.ok && response.staged) watchForSuccessfulTransition(container, beforeUrl)
    })
    return promise
  }

  function captureSubmission(event) {
    if (event.target instanceof Element) stageCredentialContainer(event.target)
  }

  function capturePotentialSubmission(event) {
    if (event.button !== undefined && event.button !== 0) return
    const target = event.target instanceof Element ? event.target : null
    const control = target?.closest('button, input[type="submit"], input[type="image"], [role="button"]')
    if (!control || control.closest('[aria-label="Hush password manager"]')) return
    const type = String(control.getAttribute('type') || '').toLowerCase()
    const label = `${control.textContent || ''} ${control.getAttribute('aria-label') || ''} ${control.getAttribute('value') || ''}`
    if ((type === 'button' || control.getAttribute('role') === 'button') && !SUBMISSION_WORDS.test(label)) return
    let container = control.closest('form, [role="form"]')
    for (let parent = control.parentElement, depth = 0; !container && parent && depth < 5; parent = parent.parentElement, depth += 1) {
      if (parent.querySelector('input[type="password"]')) container = parent
    }
    if (container) stageCredentialContainer(container)
  }

  function showSavePrompt(pending) {
    const updating = pending.operation === 'update'
    const panel = createPanel(updating ? 'Update saved password in Hush?' : 'Save this login in Hush?')
    const body = document.createElement('div')
    body.className = 'save'
    const message = document.createElement('p')
    message.textContent = `${pending.username || 'This login'} on ${pending.hostname}. Hush has not changed your vault yet.`
    const actions = document.createElement('div')
    actions.className = 'actions'
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.textContent = 'Not now'
    dismiss.addEventListener('click', () => { void runtimeMessage({ action: 'discard-pending', pageUrl: location.href }); closePanel() })
    const save = document.createElement('button')
    save.type = 'button'
    save.className = 'primary'
    save.textContent = updating ? 'Update' : 'Save'
    save.addEventListener('click', async () => {
      const response = await runtimeMessage({ action: 'save-pending', pageUrl: location.href })
      if (!response?.ok) showError(response?.error || 'Hush could not save that credential.')
      else closePanel()
    })
    actions.append(dismiss, save)
    body.append(message, actions)
    panel.append(body)
  }

  function rememberUsernameStep(context) {
    if (context.analysis.kind !== 'username-step' || context.focusRole !== 'username') return
    const username = String(context.input.value || '').slice(0, 512)
    if (username) void runtimeMessage({ action: 'stage-login-step', username, pageUrl: context.pageUrl })
  }

  function observeField(field) {
    if (observedFields.has(field) || !fieldVisible(field)) return
    const descriptor = inputDescriptor(field)
    if (descriptor.type !== 'password' && descriptor.type !== 'email' && descriptor.autocomplete !== 'username') return
    observedFields.add(field)
    field.addEventListener('focus', () => {
      activeContext = buildContext(field)
      positionTrigger(field)
      void openPanel({ automatic: true })
    })
    field.addEventListener('blur', () => {
      const context = activeContext?.input === field ? activeContext : null
      window.setTimeout(() => {
        if (context && !shadow.activeElement) rememberUsernameStep(context)
        if (!shadow.activeElement && !shadow.querySelector('.panel')) host.hidden = true
      }, 120)
    })
  }

  function checkPageTransition() {
    if (lastPageUrl === location.href) return
    lastPageUrl = location.href
    requestSerial += 1
    activeContext = null
    stagedUsername = ''
    closePanel()
    host.hidden = true
    void probePendingPrompt()
  }

  function scan() {
    scanTimer = null
    checkPageTransition()
    for (const root of rootsUnder()) for (const field of root.querySelectorAll?.('input') || []) observeField(field)
  }

  function scheduleScan() {
    if (scanTimer) return
    scanTimer = window.setTimeout(scan, 220)
  }

  trigger.addEventListener('click', () => { void openPanel({ automatic: false }) })
  document.addEventListener('submit', captureSubmission, true)
  document.addEventListener('pointerdown', (event) => {
    if (!event.composedPath().includes(host)) dismissPanel()
    capturePotentialSubmission(event)
  }, true)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') dismissPanel()
  }, true)
  window.addEventListener('popstate', checkPageTransition)
  window.addEventListener('hashchange', checkPageTransition)
  window.addEventListener('resize', () => activeContext?.input && positionTrigger(activeContext.input), { passive: true })
  window.addEventListener('scroll', () => activeContext?.input && positionTrigger(activeContext.input), { passive: true, capture: true })
  scan()

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action !== 'perform-fill' || !message.credential) return false
    const filled = performFill(message.credential)
    sendResponse({ ok: filled })
    return false
  })

  void probePendingPrompt()
}
