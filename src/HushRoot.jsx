import { useEffect, useState } from 'react'
import { ArrowRight, Check, Download, LockKeyhole, ShieldCheck, Trash2 } from 'lucide-react'
import App from './App.jsx'
import { deleteStoredVault, hasStoredVault, readStoredVault } from './lib/vaultCrypto.js'
import { detectExtensionAuthority, sendExtensionMessage } from './lib/extensionBridge.js'
import { serializeEnvelope } from './lib/vaultTransfer.js'

function downloadArchive(envelope) {
  const url = URL.createObjectURL(new Blob([serializeEnvelope(envelope, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `hush-web-migration-${new Date().toISOString().slice(0, 10)}.hush`
  link.click()
  URL.revokeObjectURL(url)
}

function ExtensionAuthority({ extensionId, initialStatus }) {
  const [status, setStatus] = useState(initialStatus)
  const [localVault, setLocalVault] = useState(false)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function refresh() {
    const [nextStatus, local] = await Promise.all([
      sendExtensionMessage(extensionId, { action: 'hush-status' }),
      hasStoredVault(),
    ])
    setStatus(nextStatus)
    setLocalVault(local)
  }

  useEffect(() => {
    let active = true
    void Promise.all([sendExtensionMessage(extensionId, { action: 'hush-status' }), hasStoredVault()]).then(([nextStatus, local]) => {
      if (!active) return
      setStatus(nextStatus)
      setLocalVault(local)
    })
    const timer = window.setInterval(() => {
      void sendExtensionMessage(extensionId, { action: 'hush-status' }).then((nextStatus) => { if (active) setStatus(nextStatus) }).catch(() => {})
    }, 5_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [extensionId])

  async function openManager(action = 'open-manager') {
    setNotice('')
    try {
      await sendExtensionMessage(extensionId, { action })
    } catch (error) {
      setNotice(error.message)
    }
  }

  async function stageMigration() {
    setBusy(true)
    setNotice('')
    try {
      const envelope = await readStoredVault()
      if (!envelope) throw new Error('No encrypted web vault was found.')
      await sendExtensionMessage(extensionId, { action: 'stage-encrypted-vault', archive: serializeEnvelope(envelope) }, 10_000)
      await sendExtensionMessage(extensionId, { action: 'open-import' })
      setNotice('Encrypted vault staged. Enter its master password only in the extension-owned window.')
    } catch (error) {
      setNotice(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function exportLegacy() {
    const envelope = await readStoredVault()
    if (envelope) downloadArchive(envelope)
  }

  async function removeLegacy() {
    if (!window.confirm('Delete the old encrypted web vault from this browser? Confirm that the extension vault opens and contains your records first.')) return
    setBusy(true)
    try {
      await deleteStoredVault()
      await refresh()
      setNotice('The old encrypted web copy was removed. The extension remains authoritative.')
    } catch (error) {
      setNotice(error.message)
    } finally {
      setBusy(false)
    }
  }

  const conflict = localVault && status.hasVault
  return (
    <main className="authority-shell">
      <section className="authority-card">
        <div className="authority-mark"><LockKeyhole size={30} /></div>
        <p className="eyebrow">EXTENSION-AUTHORITATIVE VAULT</p>
        <h1>One vault.<br /><em>One unlocked session.</em></h1>
        <p className="authority-copy">Passwords are managed by Hush’s packaged extension page. This website never receives the master password, session key, or decrypted vault.</p>
        <div className={`authority-status ${status.unlocked ? 'connected' : ''}`}>
          {status.unlocked ? <Check size={18} /> : <ShieldCheck size={18} />}
          <span><strong>{status.unlocked ? 'Vault unlocked' : status.hasVault ? 'Vault locked' : 'Ready for setup'}</strong><small>{status.unlocked ? 'The extension session is ready for management and autofill' : 'Unlock and management stay inside the extension'}</small></span>
        </div>
        {!status.hasVault && localVault && <div className="authority-migration"><h2>Move your existing web vault</h2><p>Only its authenticated encrypted envelope is staged. Enter the master password in the extension window that opens.</p><button className="primary-button" type="button" disabled={busy} onClick={stageMigration}>Move encrypted vault <ArrowRight size={16} /></button></div>}
        {!status.hasVault && !localVault && <button className="primary-button" type="button" onClick={() => openManager()}>Create vault in extension <ArrowRight size={16} /></button>}
        {status.hasVault && <button className="primary-button" type="button" onClick={() => openManager()}>Open Hush <ArrowRight size={16} /></button>}
        {conflict && <div className="authority-warning"><h2>Old web copy detected</h2><p>The extension is authoritative. Verify it first, then download or remove the disconnected encrypted web copy.</p><div><button type="button" onClick={exportLegacy}><Download size={15} /> Download backup</button><button type="button" disabled={busy} onClick={removeLegacy}><Trash2 size={15} /> Remove old copy</button></div></div>}
        {notice && <p className="authority-notice" role="status">{notice}</p>}
      </section>
    </main>
  )
}

export default function HushRoot() {
  const [authority, setAuthority] = useState(undefined)

  useEffect(() => {
    let active = true
    void detectExtensionAuthority().then((result) => { if (active) setAuthority(result) })
    return () => { active = false }
  }, [])

  if (authority === undefined) return <div className="app-loading"><i /></div>
  if (!authority) return <App />
  return <ExtensionAuthority extensionId={authority.extensionId} initialStatus={authority.status} />
}
