import { credentialCaptureFromFields, credentialIdentityFromFields, inferredCaptureKind } from './captureDetection.js'
import { classifyFormSignals, credentialFieldRole, inputDescriptor } from './formDetection.js'

if (!globalThis.__hushContentLoaded) {
  globalThis.__hushContentLoaded = true

  const observedFields = new WeakSet()
  const observedRoots = new WeakSet()
  let activeContext = null
  let scanTimer = null
  let requestSerial = 0
  let stagedUsername = ''
  let lastPageUrl = location.href
  let noticeMode = false
  let pendingUnlockResume = null
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
    .trigger.locked { color: #7b6330; border-color: #e0cfaa; background: #fff8e8; }
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
    .notice-panel { width: 260px; }
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
      mutationObserver.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['type', 'autocomplete', 'name', 'aria-label', 'aria-labelledby', 'placeholder', 'disabled', 'readonly'],
      })
    }
    const roots = [root]
    const elements = root.querySelectorAll?.('*') || []
    for (const element of elements) if (element.shadowRoot) roots.push(...rootsUnder(element.shadowRoot))
    return roots
  }

  function fieldsIn(container) {
    const candidates = container instanceof HTMLFormElement
      ? [...container.elements]
      : [...(container?.querySelectorAll?.('input') || [])]
    return candidates.filter((field) => field instanceof HTMLInputElement && fieldVisible(field))
  }

  function hasCredentialField(container) {
    return fieldsIn(container).some((field) => !['unknown', 'one-time-code'].includes(credentialFieldRole(inputDescriptor(field))))
  }

  function credentialContainerFor(element) {
    if (!(element instanceof Element)) return null
    if (element.form instanceof HTMLFormElement) return element.form
    const explicit = element.closest?.('form, [role="form"], dialog')
    if (explicit) return explicit
    let fallback = null
    for (let parent = element.parentElement, depth = 0; parent && depth < 8; parent = parent.parentElement, depth += 1) {
      if (!hasCredentialField(parent)) continue
      fallback ||= parent
      if (parent.querySelector('button, input[type="submit"], input[type="image"], [role="button"]')) return parent
    }
    return fallback || element.parentElement
  }

  function fieldsFor(input) {
    const container = credentialContainerFor(input)
    const fields = fieldsIn(container)
    return fields.length ? fields : [input]
  }

  function fieldRecord(input) {
    return { ...inputDescriptor(input), value: input.value }
  }

  function focusRole(input, fields, analysis) {
    const role = credentialFieldRole(inputDescriptor(input))
    if (role === 'username') return 'username'
    if (role === 'current-password') return 'current-password'
    if (role === 'new-password' || role === 'confirmation-password') return 'new-password'
    if (role !== 'password') return 'unknown'
    if (analysis.ambiguousPasswordCount >= 3) {
      const passwordFields = fields.filter((field) => credentialFieldRole(inputDescriptor(field)) === 'password')
      return passwordFields.indexOf(input) === 0 ? 'current-password' : 'new-password'
    }
    if (analysis.ambiguousPasswordCount === 2) return 'new-password'
    if (analysis.kind === 'registration') return 'new-password'
    if (analysis.kind === 'password-change') {
      const passwordFields = fields.filter((field) => ['password', 'current-password', 'new-password', 'confirmation-password'].includes(credentialFieldRole(inputDescriptor(field))))
      const explicitCurrent = passwordFields.find((field) => credentialFieldRole(inputDescriptor(field)) === 'current-password')
      if (explicitCurrent) return input === explicitCurrent ? 'current-password' : 'new-password'
      return passwordFields.indexOf(input) === 0 && passwordFields.length > 1 ? 'current-password' : 'new-password'
    }
    return 'password'
  }

  function buildContext(input) {
    const fields = fieldsFor(input)
    const container = credentialContainerFor(input)
    const analysis = classifyFormSignals({
      fields: fields.map(inputDescriptor),
      text: container?.textContent?.slice(0, 2000) || '',
      path: location.pathname,
    })
    return { input, fields, analysis, focusRole: focusRole(input, fields, analysis), pageUrl: location.href }
  }

  function formRequest(context) {
    return { formKind: context.analysis.ambiguousPasswordCount ? 'unknown' : context.analysis.kind, focusRole: context.focusRole }
  }

  function panelIntent(context, automatic) {
    if (context.analysis.ambiguousPasswordCount) {
      return { credentials: true, generator: context.focusRole === 'new-password' }
    }
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
    host.style.right = 'auto'
    noticeMode = false
    host.classList.toggle('above', rect.bottom + 400 > innerHeight && rect.top > 180)
    host.classList.toggle('align-left', left < 284)
    host.hidden = false
  }

  function positionNotice() {
    host.style.top = '14px'
    host.style.left = 'auto'
    host.style.right = '14px'
    host.classList.remove('above', 'align-left')
    host.hidden = false
    noticeMode = true
  }

  function closePanel() {
    shadow.querySelector('.panel')?.remove()
  }

  function dismissPanel() {
    requestSerial += 1
    pendingUnlockResume = null
    closePanel()
    if (noticeMode) host.hidden = true
    noticeMode = false
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
    if (!context.input.isConnected || location.href !== context.pageUrl) return showError('The page changed before Hush could generate that password.')
    context = buildContext(context.input)
    activeContext = context
    const generatedKind = context.analysis.ambiguousPasswordCount >= 3 ? 'password-change'
      : context.analysis.ambiguousPasswordCount === 2 ? 'registration'
        : context.analysis.kind
    const identity = credentialIdentityFromFields(context.fields.map(fieldRecord), stagedUsername)
    const response = await runtimeMessage({
      action: 'generate-password',
      pageUrl: context.pageUrl,
      capture: {
        kind: generatedKind,
        username: String(identity.username || '').slice(0, 512),
        currentPassword: String(identity.currentPassword || '').slice(0, 4096),
      },
    })
    if (!response?.ok) return showError(response?.error || 'Unlock Hush before generating a password.')
    if (location.href !== context.pageUrl || activeContext !== context || !context.input.isConnected) return showError('The page changed before Hush could use that password.')
    if (performFill({ password: response.password, mode: generatedKind, expectedPageUrl: context.pageUrl })) closePanel()
    else showError('The password fields changed before Hush could fill them.')
  }

  function panelTitle(context, intent) {
    if (intent.generator && intent.credentials) return 'Use a saved or new password'
    if (intent.generator && !intent.credentials) return 'Use a strong Hush password'
    if (context.analysis.kind === 'password-change') return 'Fill current password'
    return context.analysis.kind === 'username-step' ? 'Continue with Hush' : 'Sign in with Hush'
  }

  async function requestUnlockForContext(context, button, copy) {
    if (!context.input.isConnected || context.pageUrl !== location.href) return showError('The page changed before Hush could unlock for this field.')
    const requestId = crypto.randomUUID()
    pendingUnlockResume = {
      requestId,
      input: context.input,
      pageUrl: context.pageUrl,
      createdAt: Date.now(),
    }
    button.disabled = true
    button.textContent = 'Opening Hush…'
    const response = await runtimeMessage({ action: 'request-unlock', requestId, pageUrl: context.pageUrl })
    button.disabled = false
    button.textContent = 'Unlock Hush'
    if (!response?.ok) {
      pendingUnlockResume = null
      return showError(response?.error || 'Hush could not open its trusted unlock window.')
    }
    if (!response.resumed) copy.textContent = 'Finish unlocking in the trusted Hush extension window. This page never receives your master password.'
  }

  function appendLockedState(panel, context, response) {
    const body = document.createElement('div')
    body.className = 'save'
    const copy = document.createElement('p')
    copy.textContent = response?.error || 'Unlock your vault to continue on this field.'
    const unlock = document.createElement('button')
    unlock.type = 'button'
    unlock.className = 'generate'
    unlock.textContent = 'Unlock Hush'
    unlock.addEventListener('click', () => { void requestUnlockForContext(context, unlock, copy) })
    body.append(copy, unlock)
    panel.append(body)
  }

  async function openPanel({ automatic = false } = {}) {
    const previous = activeContext
    if (!previous || location.href !== previous.pageUrl || !previous.input.isConnected) return
    const context = buildContext(previous.input)
    activeContext = context
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
    if (response?.locked) {
      trigger.classList.add('locked')
      trigger.title = 'Unlock Hush'
      trigger.setAttribute('aria-label', 'Unlock Hush for this field')
      if (automatic) return closePanel()
    } else if (response?.ok) {
      trigger.classList.remove('locked')
      trigger.title = 'Open Hush'
      trigger.setAttribute('aria-label', 'Open Hush for this field')
    }
    if (response?.autofilled) return closePanel()
    if (automatic && response?.ok && !intent.generator && !response.credentials?.length) return closePanel()
    const panel = createPanel(panelTitle(context, intent))
    appendSite(panel)
    if (!response?.ok) {
      if (response?.locked) {
        appendLockedState(panel, context, response)
        return
      }
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
    let context = activeContext
    if (!context || !context.input.isConnected || (expectedPageUrl && (location.href !== expectedPageUrl || context.pageUrl !== expectedPageUrl))) return false
    context = buildContext(context.input)
    activeContext = context
    mode ||= context.analysis.kind
    const descriptors = context.fields.filter((field) => field.isConnected).map((field) => {
      const descriptor = inputDescriptor(field)
      return { field, descriptor, role: credentialFieldRole(descriptor) }
    })
    const usernameField = descriptors.find(({ role }) => role === 'username')
    const passwordFields = descriptors.filter(({ role }) => ['password', 'current-password', 'new-password', 'confirmation-password'].includes(role))
    const currentField = passwordFields.find(({ role }) => role === 'current-password')
    let changed = false

    if (mode === 'username-step') {
      if (username && usernameField) changed = setNativeValue(usernameField.field, username) || changed
      if (username) stagedUsername = username
      return changed
    }
    if (mode === 'current-password') {
      const target = currentField || passwordFields.find(({ role }) => role === 'password')
      if (target && password) changed = setNativeValue(target.field, password) || changed
      return changed
    }
    if (mode === 'registration' && password) {
      for (const { field, role } of passwordFields) if (role !== 'current-password') changed = setNativeValue(field, password) || changed
    } else if (mode === 'password-change' && password) {
      let targets = passwordFields.filter(({ role }) => role === 'new-password' || role === 'confirmation-password')
      const activePassword = passwordFields.find(({ field }) => field === context.input)
      if (activePassword?.role === 'password') {
        const activeIndex = passwordFields.indexOf(activePassword)
        targets = [activePassword, ...passwordFields.slice(activeIndex + 1).filter(({ role }) => role !== 'current-password')]
      }
      if (!targets.length) {
        const start = Math.max(1, passwordFields.indexOf(activePassword))
        targets = passwordFields.slice(start)
      }
      for (const { field } of targets) changed = setNativeValue(field, password) || changed
    } else if (password && passwordFields[0]) {
      changed = setNativeValue(passwordFields[0].field, password) || changed
    }
    if (mode === 'login' && username && usernameField) changed = setNativeValue(usernameField.field, username) || changed
    if (username) stagedUsername = username
    return changed
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
    const invalidField = [...document.querySelectorAll('input[aria-invalid="true"]')].some(fieldVisible)
    return invalidField || visibleStatusText('[role="alert"], [aria-live="assertive"], .error, .error-message, .field-error', FAILURE_WORDS)
  }

  function pageShowsSuccess() {
    return visibleStatusText('[role="status"], [aria-live="polite"], .success, .success-message, .notice', SUCCESS_WORDS)
  }

  function pageSuccessEvidence(container = null, beforeUrl = location.href) {
    if (pageShowsFailure()) return false
    if (location.href !== beforeUrl) return true
    const scope = container?.isConnected ? container : document
    const visiblePasswords = [...(scope.querySelectorAll?.('input') || [])]
      .filter(fieldVisible)
      .filter((field) => ['password', 'current-password', 'new-password', 'confirmation-password'].includes(credentialFieldRole(inputDescriptor(field))))
    return Boolean((container && !container.isConnected) || !visiblePasswords.length || pageShowsSuccess())
  }

  async function requestPendingPrompt(successEvidence = false) {
    const response = await runtimeMessage({
      action: 'page-ready',
      pageUrl: location.href,
      successEvidence,
      failureEvidence: pageShowsFailure(),
    })
    if (response?.autoUpdated) showAutoUpdateNotice(response.autoUpdated)
    else if (response?.pending) showSavePrompt(response.pending)
    return response
  }

  async function probePendingPrompt() {
    for (const delay of [0, 400, 1_200]) {
      if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay))
      const response = await requestPendingPrompt(pageSuccessEvidence())
      if (response?.pending || response?.autoUpdated || response?.awaitingSuccess) return
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
    const timeout = window.setTimeout(cleanup, 30_000)

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
      if (finished) return
      if (pageShowsFailure()) {
        cleanup()
        void requestPendingPrompt(false)
        return
      }
      if (!pageSuccessEvidence(container, beforeUrl)) return
      cleanup()
      void requestPendingPrompt(true)
    }

    observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'style', 'class'] })
    checkTimer = window.setTimeout(check, 500)
  }

  function stageCredentialContainer(container) {
    container = credentialContainerFor(container) || container
    if (!(container instanceof Element)) return null
    const recent = stagedSubmissions.get(container)
    if (recent && Date.now() - recent.createdAt < 300) return recent.promise
    const fields = fieldsIn(container)
    const analysis = classifyFormSignals({ fields: fields.map(inputDescriptor), text: container.textContent?.slice(0, 2000), path: location.pathname })
    if (analysis.kind === 'username-step') {
      const { username } = credentialIdentityFromFields(fields.map(fieldRecord), stagedUsername)
      return username ? runtimeMessage({ action: 'stage-login-step', username, pageUrl: location.href }) : null
    }
    const fieldRecords = fields.map(fieldRecord)
    const capture = credentialCaptureFromFields({ fields: fieldRecords, kind: inferredCaptureKind(fieldRecords, analysis), fallbackUsername: stagedUsername })
    if (!capture.ok || capture.password.length > 4096) return null
    const beforeUrl = location.href
    const promise = runtimeMessage({
      action: 'stage-credential',
      pageUrl: beforeUrl,
      capture: {
        kind: capture.kind,
        username: String(capture.username || '').slice(0, 512),
        password: capture.password,
        currentPassword: String(capture.currentPassword || '').slice(0, 4096),
        ambiguousForm: analysis.ambiguousPasswordCount > 0,
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
    const container = credentialContainerFor(control)
    if (!container) return
    const type = String(control.type || control.getAttribute('type') || '').toLowerCase()
    const label = `${control.textContent || ''} ${control.getAttribute('aria-label') || ''} ${control.getAttribute('value') || ''}`
    if ((type === 'button' || control.getAttribute('role') === 'button') && !SUBMISSION_WORDS.test(label)) {
      if (control.hasAttribute('aria-expanded') || control.hasAttribute('aria-pressed') || control.hasAttribute('aria-controls') || control.hasAttribute('aria-haspopup')) return
      const structuralHint = /(?:primary|submit|continue|login|register|save|next)/iu.test(`${control.id} ${control.className} ${control.getAttribute('data-testid') || ''}`)
      const visibleActions = [...container.querySelectorAll('button, input[type="submit"], input[type="image"], [role="button"]')]
        .filter((candidate) => visibleElement(candidate) && !candidate.closest('[aria-label="Hush password manager"]'))
      if (!structuralHint && visibleActions.length !== 1) return
    }
    stageCredentialContainer(container)
  }

  function showSavePrompt(pending) {
    positionNotice()
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

  function showAutoUpdateNotice(update) {
    positionNotice()
    const panel = createPanel('Password updated in Hush')
    panel.classList.add('notice-panel')
    const body = document.createElement('div')
    body.className = 'save'
    const message = document.createElement('p')
    message.textContent = `${update.username || 'This login'} on ${update.hostname} now uses the password that just signed in.`
    const actions = document.createElement('div')
    actions.className = 'actions'
    const done = document.createElement('button')
    done.type = 'button'
    done.textContent = 'Done'
    done.addEventListener('click', dismissPanel)
    const undo = document.createElement('button')
    undo.type = 'button'
    undo.className = 'primary'
    undo.textContent = 'Undo'
    undo.disabled = update.canUndo !== true
    undo.addEventListener('click', async () => {
      undo.disabled = true
      const response = await runtimeMessage({ action: 'undo-auto-update', pageUrl: location.href })
      if (!response?.ok) return showError(response?.error || 'That automatic update can no longer be undone.')
      dismissPanel()
    })
    actions.append(done, undo)
    body.append(message, actions)
    panel.append(body)
    window.setTimeout(() => {
      if (panel.isConnected) dismissPanel()
    }, 15_000)
  }

  function rememberUsernameStep(context) {
    if (context.analysis.kind !== 'username-step' || context.focusRole !== 'username') return
    const username = String(context.input.value || '').slice(0, 512)
    if (username) void runtimeMessage({ action: 'stage-login-step', username, pageUrl: context.pageUrl })
  }

  function observeField(field) {
    if (observedFields.has(field) || !fieldVisible(field)) return
    const descriptor = inputDescriptor(field)
    if (['unknown', 'one-time-code'].includes(credentialFieldRole(descriptor))) return
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
    noticeMode = false
    pendingUnlockResume = null
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
  document.addEventListener('click', capturePotentialSubmission, true)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') dismissPanel()
    if (event.key === 'Enter' && !event.isComposing && event.target instanceof HTMLInputElement) {
      const role = credentialFieldRole(inputDescriptor(event.target))
      if (!['unknown', 'one-time-code'].includes(role)) stageCredentialContainer(credentialContainerFor(event.target))
    }
  }, true)
  window.addEventListener('popstate', checkPageTransition)
  window.addEventListener('hashchange', checkPageTransition)
  window.addEventListener('resize', () => activeContext?.input && positionTrigger(activeContext.input), { passive: true })
  window.addEventListener('scroll', () => activeContext?.input && positionTrigger(activeContext.input), { passive: true, capture: true })
  scan()

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action === 'perform-fill' && message.credential) {
      const filled = performFill(message.credential)
      sendResponse({ ok: filled })
      return false
    }
    if (message?.action === 'resume-after-unlock') {
      const pending = pendingUnlockResume
      pendingUnlockResume = null
      const resumable = Boolean(pending
        && pending.requestId === message.requestId
        && message.origin === location.origin
        && pending.pageUrl === location.href
        && Date.now() - pending.createdAt <= 2 * 60_000
        && pending.input.isConnected)
      if (!resumable) {
        sendResponse({ ok: false })
        return false
      }
      trigger.classList.remove('locked')
      trigger.title = 'Open Hush'
      trigger.setAttribute('aria-label', 'Open Hush for this field')
      activeContext = buildContext(pending.input)
      positionTrigger(pending.input)
      void openPanel({ automatic: false })
      sendResponse({ ok: true })
      return false
    }
    return false
  })

  void probePendingPrompt()
}
