import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import QRCode from 'qrcode'
import QrScanner from 'qr-scanner'
import {
  AlertTriangle,
  ArrowRight,
  Camera,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  Database,
  Download,
  Edit3,
  ExternalLink,
  Eye,
  EyeOff,
  FileKey2,
  FileUp,
  Folder,
  HardDrive,
  Heart,
  Import,
  Info,
  KeyRound,
  LayoutGrid,
  Laptop,
  Link2,
  Lock,
  LockKeyhole,
  LogOut,
  Menu,
  Plus,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  Share2,
  Sparkles,
  Star,
  Smartphone,
  Trash2,
  Unplug,
  UserRound,
  WandSparkles,
  Wifi,
  X,
  Zap,
} from 'lucide-react'
import ImportView from './components/ImportView.jsx'
import { sampleEntries } from './data/sampleVault.js'
import * as defaultVaultApi from './lib/vaultCrypto.js'
import { createDeviceLink } from './lib/deviceLink.js'
import { safeHttpUrl } from './lib/importer.js'
import {
  countPasswords,
  masterPasswordHealth,
  passwordHealth,
  passwordRisk,
  vaultHealthScore,
} from './lib/passwordRisk.js'
import { generatePassphrase, generatePassword, GENERATOR_DEFAULTS } from './lib/passwordGenerator.js'
import {
  compareEnvelopeVersions,
  decodePairingCode,
  pairingCodeFromQr,
  pairingCodeToQr,
  sameVault,
  deserializeEnvelope,
  serializeEnvelope,
} from './lib/vaultTransfer.js'

const { ARGON2_PARAMS } = defaultVaultApi

const emptyEntry = {
  name: '',
  username: '',
  password: '',
  url: '',
  notes: '',
  collection: 'Personal',
  favorite: false,
  tags: [],
}

const navItems = [
  { id: 'vault', label: 'Vault', icon: LayoutGrid },
  { id: 'security', label: 'Security', icon: ShieldCheck },
  { id: 'import', label: 'Import', icon: Import },
  { id: 'settings', label: 'Settings', icon: Settings },
]

function BrandMark({ decorative = true }) {
  return <img className="brand-mark-image" src="/hush-mark.png" alt={decorative ? '' : 'Hush'} />
}

function initials(name = '') {
  return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()
}

function avatarHue(name = '') {
  return [...name].reduce((total, character) => total + character.charCodeAt(0), 0) % 360
}

function normalizePasswordDates(items) {
  const now = new Date().toISOString()
  return items.map((entry) => ({
    ...entry,
    id: entry.id || crypto.randomUUID(),
    revision: Math.max(1, Number(entry.revision) || 1),
    encryptionVersion: 2,
    createdAt: entry.createdAt || now,
    updatedAt: entry.updatedAt || entry.createdAt || now,
    passwordChangedAt: entry.passwordChangedAt || entry.updatedAt || entry.createdAt || now,
    passwordHistory: Array.isArray(entry.passwordHistory) ? entry.passwordHistory : [],
  }))
}

function formatUpdated(value) {
  if (!value) return 'Just now'
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 30) return `${days} days ago`
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(value))
}

function formatLastUsed(entry) {
  if (!entry.lastUsedAt) return entry.lastUsed || formatUpdated(entry.updatedAt)
  const elapsed = Math.max(0, Date.now() - new Date(entry.lastUsedAt).getTime())
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'Yesterday'
  if (days < 30) return `${days} days ago`
  return formatUpdated(entry.lastUsedAt)
}

function mutationErrorMessage(error, fallback) {
  return error?.message?.includes('changed in another tab') ? error.message : fallback
}

const DEFAULT_PREFERENCES = Object.freeze({ autoLockMinutes: 15, clipboardClearSeconds: 30, passwordHistoryLimit: 5 })

function normalizePreferences(preferences = {}) {
  const autoLockMinutes = [0, 5, 15, 30, 60].includes(Number(preferences.autoLockMinutes)) ? Number(preferences.autoLockMinutes) : DEFAULT_PREFERENCES.autoLockMinutes
  const clipboardClearSeconds = [15, 30, 60, 120].includes(Number(preferences.clipboardClearSeconds)) ? Number(preferences.clipboardClearSeconds) : DEFAULT_PREFERENCES.clipboardClearSeconds
  const passwordHistoryLimit = [0, 3, 5, 10].includes(Number(preferences.passwordHistoryLimit)) ? Number(preferences.passwordHistoryLimit) : DEFAULT_PREFERENCES.passwordHistoryLimit
  return { autoLockMinutes, clipboardClearSeconds, passwordHistoryLimit }
}

function useDialogFocus(onClose) {
  const dialogRef = useRef(null)
  useEffect(() => {
    const dialog = dialogRef.current
    const previousFocus = document.activeElement
    const background = [...document.querySelectorAll('.app-shell > :not(.modal-backdrop):not(.onboarding-backdrop):not(.toast)')]
    background.forEach((element) => { element.inert = true })

    function focusableElements() {
      return [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')]
    }

    function handleKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = focusableElements()
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    dialog.addEventListener('keydown', handleKeydown)
    const focusFrame = requestAnimationFrame(() => {
      if (!dialog.contains(document.activeElement)) focusableElements()[0]?.focus()
    })
    return () => {
      cancelAnimationFrame(focusFrame)
      dialog.removeEventListener('keydown', handleKeydown)
      background.forEach((element) => { element.inert = false })
      if (previousFocus instanceof HTMLElement) previousFocus.focus()
    }
  }, [])
  return dialogRef
}

async function clearClipboardIfMatches(value) {
  if (!value || !navigator.clipboard?.readText) return
  try {
    const current = await navigator.clipboard.readText()
    if (current === value) await navigator.clipboard.writeText('')
  } catch {
    // Clipboard permissions are browser-controlled; clearing is best effort.
  }
}

function Sidebar({ view, setView, filter, setFilter, entries, encrypted, linkState, onLock, collapsed, setCollapsed }) {
  const passwordCounts = useMemo(() => countPasswords(entries), [entries])
  const linked = linkState.state === 'connected' || linkState.state === 'syncing'
  const riskCount = useMemo(() => entries.filter((entry) => passwordRisk(entry, passwordCounts).atRisk).length, [entries, passwordCounts])
  const collections = useMemo(() => {
    const counts = new Map()
    entries.forEach((entry) => counts.set(entry.collection || 'Unsorted', (counts.get(entry.collection || 'Unsorted') || 0) + 1))
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [entries])

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="brand-row">
        <button className="brand-seal" type="button" onClick={() => setView('vault')} aria-label="Hush home"><BrandMark /></button>
        <div className="wordmark"><strong>hush.</strong><span>PRIVATE VAULT</span></div>
        <button className="collapse-button" type="button" onClick={() => setCollapsed(!collapsed)} aria-label="Toggle navigation"><Menu size={18} /></button>
      </div>

      <nav className="primary-nav" aria-label="Main navigation">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" data-nav={id} aria-label={label} aria-current={view === id ? 'page' : undefined} className={view === id ? 'active' : ''} onClick={() => setView(id)}>
            <Icon size={18} /><span>{label}</span>{id === 'import' && <b>CSV</b>}
          </button>
        ))}
      </nav>

      <div className="sidebar-rule" />
      <div className="side-section">
        <p>Smart views</p>
        <button type="button" aria-label="Favorites" aria-pressed={view === 'vault' && filter === 'favorites'} className={view === 'vault' && filter === 'favorites' ? 'active' : ''} onClick={() => { setView('vault'); setFilter('favorites') }}><Star size={16} /><span>Favorites</span><em>{entries.filter((entry) => entry.favorite).length}</em></button>
        <button type="button" aria-label="Recently used" aria-pressed={view === 'vault' && filter === 'recent'} className={view === 'vault' && filter === 'recent' ? 'active' : ''} onClick={() => { setView('vault'); setFilter('recent') }}><Clock3 size={16} /><span>Recently used</span></button>
        <button type="button" aria-label={`${riskCount} passwords at risk`} aria-pressed={view === 'vault' && filter === 'risk'} className={view === 'vault' && filter === 'risk' ? 'active' : ''} onClick={() => { setView('vault'); setFilter('risk') }}><AlertTriangle size={16} /><span>Passwords at risk</span><em>{riskCount}</em></button>
      </div>

      <div className="side-section collections">
        <p>Collections</p>
        {collections.slice(0, 5).map(([name, count]) => (
          <button type="button" aria-label={`${name} collection, ${count} items`} aria-pressed={view === 'vault' && filter === `collection:${name}`} className={view === 'vault' && filter === `collection:${name}` ? 'active' : ''} key={name} onClick={() => { setView('vault'); setFilter(`collection:${name}`) }}>
            <span className="collection-dot" style={{ '--dot-hue': avatarHue(name) }} /><span>{name}</span><em>{count}</em>
          </button>
        ))}
      </div>

      <div className="sidebar-bottom">
        <div className="device-status"><span className={linked || encrypted ? 'safe' : 'demo'}>{linked ? <Wifi size={15} /> : <HardDrive size={15} />}</span><div><strong>{linked ? 'Device link live' : encrypted ? 'Encrypted here' : 'Preview vault'}</strong><small>{linked ? 'Two-way encrypted sync' : encrypted ? 'AES-256-GCM · local' : 'Not saved yet'}</small></div></div>
        <button className="lock-button" type="button" aria-label={encrypted ? 'Lock vault' : 'Protect this vault'} onClick={onLock}><Lock size={16} /><span>{encrypted ? 'Lock vault' : 'Protect this vault'}</span></button>
      </div>
    </aside>
  )
}

function Topbar({ search, setSearch, searchRef, onAdd, encrypted, linkState, onHelp }) {
  const linked = linkState.state === 'connected' || linkState.state === 'syncing'
  return (
    <div className="topbar">
      <label className="search-box">
        <Search size={18} />
        <input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search your vault" aria-label="Search your vault" />
        <kbd>⌘ K</kbd>
      </label>
      <div className="top-actions">
        <span className={`sync-state ${encrypted ? '' : 'demo'}`}><i /> {linked ? 'Linked · syncing both ways' : encrypted ? 'Encrypted & saved' : 'Demo changes are temporary'}</span>
        <button type="button" className="icon-button" aria-label="Keyboard help" onClick={onHelp}><CircleHelp size={19} /></button>
        <button type="button" className="new-secret" onClick={onAdd}><Plus size={18} /> New secret</button>
      </div>
    </div>
  )
}

function SecretList({ entries, passwordCounts, selectedId, setSelectedId, filter, setFilter, onClear }) {
  return (
    <section className="secret-list-panel" aria-labelledby="secret-list-title">
      <div className="list-heading">
        <div><p className="eyebrow">Personal archive</p><h2 id="secret-list-title">{filter === 'all' ? 'All secrets' : filter === 'favorites' ? 'Favorites' : filter === 'recent' ? 'Recently used' : filter === 'risk' ? 'Passwords at risk' : filter.replace('collection:', '')}</h2></div>
        <span>{entries.length.toString().padStart(2, '0')}</span>
      </div>
      <div className="filter-row">
        {['all', 'favorites', 'recent', 'risk'].map((item) => <button type="button" key={item} aria-pressed={filter === item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item === 'all' ? 'All items' : item === 'favorites' ? 'Starred' : item === 'recent' ? 'Recent' : 'At risk'}</button>)}
      </div>
      <div className="secret-list" aria-label="Saved logins">
        {entries.map((entry, index) => {
          const health = passwordHealth(entry, passwordCounts)
          const risk = passwordRisk(entry, passwordCounts)
          return (
            <button
              type="button"
              aria-pressed={selectedId === entry.id}
              className={`secret-row ${selectedId === entry.id ? 'selected' : ''}`}
              key={entry.id}
              onClick={() => setSelectedId(entry.id)}
              style={{ '--row-delay': `${Math.min(index, 8) * 35}ms` }}
            >
              <span className="service-avatar" style={{ '--avatar-hue': avatarHue(entry.name) }}>{initials(entry.name)}</span>
              <span className="secret-main"><strong>{entry.name}</strong><small>{entry.username || 'No username'}</small></span>
              <span className={`secret-meta ${filter === 'risk' ? `risk ${risk.tone}` : ''}`}>{filter === 'risk' ? <><AlertTriangle size={13} />{risk.shortReason}</> : <>{entry.favorite && <Star size={13} fill="currentColor" />}<i className={health.tone} />{formatLastUsed(entry)}</>}</span>
              <ChevronRight className="row-chevron" size={17} />
            </button>
          )
        })}
        {!entries.length && (
          <div className="no-results"><span><Search size={22} /></span><strong>No secrets found</strong><p>Try a different word or clear the current view.</p><button type="button" onClick={onClear}>Clear search & filters</button></div>
        )}
      </div>
    </section>
  )
}

function DetailPanel({ entry, passwordCounts, onCopy, clipboardState, onEdit, onDelete, onClearHistory, mobileOpen, onMobileClose }) {
  const [revealed, setRevealed] = useState(false)
  const [historyRevealed, setHistoryRevealed] = useState(false)
  useEffect(() => { setRevealed(false); setHistoryRevealed(false) }, [entry?.id])

  if (!entry) {
    return <aside className="detail-panel empty-detail"><span><KeyRound size={28} /></span><h3>Select a secret</h3><p>Its useful details will appear here, quietly and only when you need them.</p></aside>
  }

  const risk = passwordRisk(entry, passwordCounts)
  const health = risk.health
  const passwordChangedAt = entry.passwordChangedAt || entry.updatedAt || entry.createdAt
  const url = safeHttpUrl(entry.url)
  return (
    <aside className={`detail-panel detail-enter ${mobileOpen ? 'mobile-open' : ''}`} aria-label={`${entry.name} details`} role={mobileOpen ? 'dialog' : undefined} aria-modal={mobileOpen || undefined}>
      <div className="detail-topline"><span className={`health-label ${risk.tone}`}><i /> {risk.atRisk ? 'Password at risk' : `${health.label} password`}</span><div><button type="button" className="icon-button mobile-detail-close" onClick={onMobileClose} aria-label="Close secret details"><X size={17} /></button><button type="button" className="icon-button" onClick={() => onEdit(entry)} aria-label={`Edit ${entry.name}`}><Edit3 size={17} /></button></div></div>
      <div className="detail-identity">
        <span className="large-avatar" style={{ '--avatar-hue': avatarHue(entry.name) }}>{initials(entry.name)}</span>
        <div><h2>{entry.name}</h2>{url ? <a href={url} target="_blank" rel="noreferrer">{new URL(url).hostname.replace(/^www\./, '')}<ExternalLink size={13} /></a> : <span>No website saved</span>}</div>
        <button type="button" className={`favorite-button ${entry.favorite ? 'active' : ''}`} onClick={() => onEdit({ ...entry, favorite: !entry.favorite }, true)} aria-label={entry.favorite ? 'Remove from favorites' : 'Add to favorites'}><Heart size={17} fill={entry.favorite ? 'currentColor' : 'none'} /></button>
      </div>

      <div className="detail-rule" />
      <div className="field-block">
        <label>Username</label>
        <div className="field-value"><span>{entry.username || '—'}</span>{entry.username && <button type="button" onClick={() => onCopy('Username', entry.username)} aria-label="Copy username"><Copy size={16} /></button>}</div>
      </div>
      <div className="field-block password-field">
        <label>Password <span className={`strength-mini ${health.tone}`}>{health.value}%</span></label>
        <div className="field-value"><span className={revealed ? 'revealed-password' : 'masked-password'} aria-label={revealed ? entry.password : 'Password hidden'}>{revealed ? entry.password : '••••••••••••••••'}</span><div><button type="button" onClick={() => setRevealed(!revealed)} aria-label={revealed ? 'Hide password' : 'Reveal password'} aria-pressed={revealed}>{revealed ? <EyeOff size={17} /> : <Eye size={17} />}</button><button className="copy-primary" type="button" onClick={() => onCopy('Password', entry.password)} aria-label="Copy password">{clipboardState?.label === 'Password' ? <><Check size={15} /> {clipboardState.remaining}s</> : <><Copy size={15} /> Copy</>}</button></div></div>
        <div className="strength-line"><i style={{ width: `${health.value}%` }} className={health.tone} /></div>
        <p className="guess-estimate">{health.label} · about {health.entropyBits} bits of local estimated guess resistance</p>
        {risk.atRisk && <div className={`password-risk-note ${risk.tone}`}><AlertTriangle size={15} /><span>{risk.reason}</span></div>}
      </div>
      {entry.notes && <div className="field-block notes-field"><label>Private note</label><p>{entry.notes}</p></div>}
      {entry.passwordHistory?.length > 0 && <div className="field-block history-field"><div className="history-heading"><label>Password history · {entry.passwordHistory.length}</label><div><button type="button" onClick={() => setHistoryRevealed((current) => !current)}>{historyRevealed ? 'Hide' : 'Reveal'}</button><button type="button" onClick={() => onClearHistory(entry)}>Delete history</button></div></div>{entry.passwordHistory.map((item) => <div className="history-row" key={`${item.changedAt}-${item.password.length}`}><span>{formatUpdated(item.changedAt)}</span><code>{historyRevealed ? item.password : '••••••••••••'}</code>{historyRevealed && <button type="button" onClick={() => onCopy('Previous password', item.password)} aria-label="Copy previous password"><Copy size={14} /></button>}</div>)}</div>}
      <div className="tag-row">{(entry.tags || []).map((tag) => <span key={tag}>#{tag}</span>)}<span>{entry.collection || 'Unsorted'}</span></div>
      <div className="detail-footer"><div><span>Password changed</span><strong>{passwordChangedAt ? formatUpdated(passwordChangedAt) : 'Unknown'}</strong></div><div><span>Created</span><strong>{new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric' }).format(new Date(entry.createdAt))}</strong></div><button type="button" onClick={() => onDelete(entry)}><Trash2 size={15} /> Delete</button></div>
    </aside>
  )
}

function VaultView({ entries, search, setSearch, filter, setFilter, selectedId, setSelectedId, searchRef, onAdd, onEdit, onDelete, onClearHistory, onCopy, onUse, clipboardState, encrypted, linkState, onSecurity, onHelp }) {
  const passwordCounts = useMemo(() => countPasswords(entries), [entries])
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const visibleEntries = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return entries.filter((entry) => {
      const searchMatch = !needle || [entry.name, entry.username, entry.url, entry.collection, ...(entry.tags || [])].join(' ').toLowerCase().includes(needle)
      const filterMatch = filter === 'all'
        || (filter === 'favorites' && entry.favorite)
        || (filter === 'recent' && (entry.lastUsedAt || (entry.lastUsed && entry.lastUsed !== 'Never')))
        || (filter === 'risk' && passwordRisk(entry, passwordCounts).atRisk)
        || (filter.startsWith('collection:') && entry.collection === filter.slice(11))
      return searchMatch && filterMatch
    }).sort((a, b) => {
      if (filter === 'recent') return new Date(b.lastUsedAt || b.updatedAt) - new Date(a.lastUsedAt || a.updatedAt)
      if (filter === 'risk') {
        const aRisk = passwordRisk(a, passwordCounts)
        const bRisk = passwordRisk(b, passwordCounts)
        return Number(bRisk.reused) - Number(aRisk.reused)
          || aRisk.health.value - bRisk.health.value
      }
      return Number(b.favorite) - Number(a.favorite)
    })
      .slice(0, filter === 'recent' ? 6 : entries.length)
  }, [entries, search, filter, passwordCounts])

  const selected = visibleEntries.find((entry) => entry.id === selectedId) || visibleEntries[0]
  const issues = entries.filter((entry) => passwordRisk(entry, passwordCounts).atRisk).length
  const score = vaultHealthScore(entries, passwordCounts)

  useEffect(() => setMobileDetailOpen(false), [filter, search])
  useEffect(() => {
    if (!mobileDetailOpen) return undefined
    const previousFocus = document.activeElement
    const panel = document.querySelector('.detail-panel.mobile-open')
    if (!panel) return undefined
    const background = [...document.querySelectorAll('.mobile-header, .mobile-nav, .topbar, .vault-intro, .secret-list-panel')]
    background.forEach((element) => { element.inert = true })
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusable = () => [...panel.querySelectorAll('button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')]
    const handleKeydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMobileDetailOpen(false)
      } else if (event.key === 'Tab') {
        const options = focusable()
        const first = options[0]
        const last = options[options.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    panel.addEventListener('keydown', handleKeydown)
    requestAnimationFrame(() => panel.querySelector('.mobile-detail-close')?.focus())
    return () => {
      panel.removeEventListener('keydown', handleKeydown)
      background.forEach((element) => { element.inert = false })
      document.body.style.overflow = previousOverflow
      if (previousFocus instanceof HTMLElement) previousFocus.focus()
    }
  }, [mobileDetailOpen, selected?.id])

  return (
    <main className="vault-view page-enter">
      <Topbar search={search} setSearch={setSearch} searchRef={searchRef} onAdd={onAdd} encrypted={encrypted} linkState={linkState} onHelp={onHelp} />
      <section className="vault-intro">
        <div><p className="eyebrow"><span className="live-pip" /> Vault open · just for you</p><h1>Your private things,<br /><em>beautifully in order.</em></h1></div>
        <div className="vault-pulse"><div className="score-ring" style={{ '--score': `${score * 3.6}deg` }}><span>{score}</span></div><div><strong>Vault health</strong><span>{issues ? `${issues} password${issues === 1 ? '' : 's'} at risk` : 'Everything looks excellent'}</span></div><button type="button" onClick={onSecurity} aria-label="Open security"><ChevronRight size={18} /></button></div>
      </section>
      <section className="vault-workspace">
        <SecretList entries={visibleEntries} passwordCounts={passwordCounts} selectedId={selected?.id} setSelectedId={(id) => { setSelectedId(id); onUse(id); if (window.matchMedia('(max-width: 700px)').matches) setMobileDetailOpen(true) }} filter={filter} setFilter={setFilter} onClear={() => { setFilter('all'); setSearch('') }} />
        <DetailPanel key={selected?.id || 'empty'} entry={selected} passwordCounts={passwordCounts} onCopy={onCopy} clipboardState={clipboardState} onEdit={onEdit} onDelete={onDelete} onClearHistory={onClearHistory} mobileOpen={mobileDetailOpen} onMobileClose={() => setMobileDetailOpen(false)} />
      </section>
    </main>
  )
}

function SecurityView({ entries, onBackToVault }) {
  const passwordCounts = useMemo(() => countPasswords(entries), [entries])
  const risks = entries.map((entry) => ({ entry, risk: passwordRisk(entry, passwordCounts) }))
    .filter(({ risk }) => risk.atRisk)
    .sort((a, b) => Number(b.risk.reused) - Number(a.risk.reused)
      || a.risk.health.value - b.risk.health.value)
  const reusedCount = risks.filter(({ risk }) => risk.reused).length
  const weakCount = risks.filter(({ risk }) => risk.lowStrength && !risk.reused).length
  const healthyCount = entries.length - risks.length
  const score = vaultHealthScore(entries, passwordCounts)
  return (
    <main className="security-view page-enter">
      <header className="page-heading security-heading"><div><p className="eyebrow"><ShieldCheck size={14} /> Local security check</p><h1>A quiet check on<br /><em>your digital doors.</em></h1><p className="heading-copy">Hush looks for reuse, predictable patterns, account information, common passwords, and weak length. Password age is informational only, and this analysis stays local.</p></div><div className="giant-score"><span>{score}</span><small>out of 100</small><i style={{ '--score': `${score * 3.6}deg` }} /></div></header>
      <div className="security-grid">
        <section className="security-overview">
          <div className="security-stat good"><span><Shield size={21} /></span><strong>{healthyCount}</strong><p>Strong & unique</p><small>No current local risk flags</small></div>
          <div className="security-stat warn"><span><Copy size={21} /></span><strong>{reusedCount}</strong><p>Reused</p><small>Same password on multiple entries</small></div>
          <div className="security-stat danger"><span><AlertTriangle size={21} /></span><strong>{weakCount}</strong><p>Weak patterns</p><small>Predictable, contextual, or too short</small></div>
        </section>
        <section className="security-story">
          <div className="story-seal"><BrandMark /></div>
          <p className="eyebrow">What protection means here</p>
          <h2>Your vault is encrypted<br />before it is stored.</h2>
          <p>A random AES-256-GCM key protects the complete vault—including names, URLs, and notes. Your master password derives a wrapping key with Argon2id ({Math.round(ARGON2_PARAMS.memorySize / 1024)} MiB, {ARGON2_PARAMS.iterations} passes) and is never stored.</p>
          <div className="security-flow"><span>Master password</span><i /><span>Wrapped key</span><i /><span>Encrypted vault</span></div>
        </section>
        <section className="attention-list">
          <div className="section-title"><div><p className="eyebrow">Worth a look</p><h2>Passwords at risk.</h2></div><span>{risks.length}</span></div>
          {risks.slice(0, 5).map(({ entry, risk }) => {
            const badge = risk.reused ? 'Reused' : `${risk.health.value}%`
            return <button type="button" key={entry.id} onClick={() => onBackToVault(entry.id)}><span className="service-avatar" style={{ '--avatar-hue': avatarHue(entry.name) }}>{initials(entry.name)}</span><span><strong>{entry.name}</strong><small>{risk.reason}</small></span><b className={risk.tone}>{badge}</b><ChevronRight size={17} /></button>
          })}
          {!risks.length && <div className="all-clear"><Check size={22} /><strong>All clear</strong><span>Every saved password passes the current local checks.</span></div>}
        </section>
      </div>
    </main>
  )
}

function PairingQr({ value, label }) {
  const [source, setSource] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setSource('')
    setError('')
    if (!value) return () => { active = false }
    QRCode.toDataURL(pairingCodeToQr(value), {
      errorCorrectionLevel: 'L',
      margin: 2,
      width: 360,
      color: { dark: '#171813ff', light: '#ffffffff' },
    }).then((image) => {
      if (active) setSource(image)
    }).catch(() => {
      if (active) setError('This connection code is too large for a QR. Use the text code below.')
    })
    return () => { active = false }
  }, [value])

  if (error) return <p className="inline-error qr-error"><AlertTriangle size={15} /> {error}</p>
  return (
    <div className="pairing-qr">
      {source ? <img src={source} alt={label} /> : <div className="qr-loading" aria-label="Creating QR code"><span /></div>}
      <p><Camera size={14} /> {label}</p>
    </div>
  )
}

function QrScannerDialog({ expectedType, onClose, onScan }) {
  const videoRef = useRef(null)
  const deliveredRef = useRef(false)
  const onScanRef = useRef(onScan)
  const [error, setError] = useState('')
  onScanRef.current = onScan
  const dialogRef = useDialogFocus(onClose)

  function deliverScan(value) {
    try {
      const code = pairingCodeFromQr(value)
      decodePairingCode(code, expectedType)
      if (deliveredRef.current) return true
      deliveredRef.current = true
      onScanRef.current(code)
      return true
    } catch (scanError) {
      setError(scanError.message || `That is not a Hush ${expectedType} QR code.`)
      return false
    }
  }

  useEffect(() => {
    let scanner
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera access is unavailable here. Choose a QR image or paste the text code instead.')
      return undefined
    }
    scanner = new QrScanner(
      videoRef.current,
      (result) => {
        if (deliverScan(result.data)) scanner.stop()
      },
      {
        preferredCamera: 'environment',
        maxScansPerSecond: 10,
        highlightScanRegion: true,
        highlightCodeOutline: true,
        returnDetailedScanResult: true,
        onDecodeError: () => {},
      },
    )
    scanner.start().catch(() => {
      setError('Hush could not open the camera. Allow camera access, choose a QR image, or paste the code instead.')
    })
    return () => scanner.destroy()
  }, [expectedType])

  async function scanImage(event) {
    const file = event.target.files?.[0]
    if (!file) return
    setError('')
    try {
      const result = await QrScanner.scanImage(file, { returnDetailedScanResult: true })
      deliverScan(result.data)
    } catch {
      setError('Hush could not find a readable QR code in that image.')
    } finally {
      event.target.value = ''
    }
  }

  return createPortal(
    <div className="modal-backdrop qr-scanner-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="qr-scanner-dialog modal-enter" role="dialog" aria-modal="true" aria-labelledby="qr-scanner-title">
        <header><div><p className="eyebrow"><Camera size={14} /> Hush device link</p><h2 id="qr-scanner-title">Scan the {expectedType} QR.</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close QR scanner"><X size={19} /></button></header>
        <div className="qr-camera"><video ref={videoRef} muted playsInline /><div className="qr-camera-guide"><span /><span /><span /><span /></div></div>
        <div className="qr-scanner-copy"><p>Point this device at the QR shown in Hush on your other device.</p>{error && <p className="inline-error" role="alert"><AlertTriangle size={15} /> {error}</p>}<label className="secondary-button qr-file-button"><Camera size={16} /> Choose a QR image<input type="file" accept="image/*" onChange={scanImage} /></label></div>
      </section>
    </div>,
    document.body,
  )
}

function DeviceSyncCard({ encrypted, linkState, peerName, onCreateOffer, onAcceptOffer, onAcceptAnswer, onDisconnect }) {
  const [mode, setMode] = useState('idle')
  const [offerCode, setOfferCode] = useState('')
  const [answerCode, setAnswerCode] = useState('')
  const [remoteCode, setRemoteCode] = useState('')
  const [scannerType, setScannerType] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [answerAccepted, setAnswerAccepted] = useState(false)
  const connected = linkState.state === 'connected' || linkState.state === 'syncing'

  async function copyCode(value) {
    try {
      await navigator.clipboard.writeText(value)
      setError('')
    } catch {
      setError('Clipboard access was blocked. Select the code and copy it manually.')
    }
  }

  async function createOfferCode() {
    setBusy(true)
    setError('')
    try {
      setOfferCode(await onCreateOffer())
    } catch (offerError) {
      setError(offerError.message || 'Could not create a pairing code.')
    } finally {
      setBusy(false)
    }
  }

  async function createAnswerCode(code = remoteCode) {
    setBusy(true)
    setError('')
    try {
      setAnswerCode(await onAcceptOffer(code))
    } catch (answerError) {
      setError(answerError.message || 'Could not read that pairing code.')
    } finally {
      setBusy(false)
    }
  }

  async function finishPairing(code = remoteCode) {
    setBusy(true)
    setError('')
    try {
      await onAcceptAnswer(code)
      setAnswerAccepted(true)
    } catch (answerError) {
      setError(answerError.message || 'Could not open the device link.')
    } finally {
      setBusy(false)
    }
  }

  function handleScannedCode(code) {
    const scannedType = scannerType
    setScannerType('')
    setRemoteCode(code)
    if (scannedType === 'offer') void createAnswerCode(code)
    if (scannedType === 'answer') void finishPairing(code)
  }

  function reset() {
    onDisconnect()
    setMode('idle')
    setOfferCode('')
    setAnswerCode('')
    setRemoteCode('')
    setScannerType('')
    setError('')
    setAnswerAccepted(false)
  }

  return (
    <>
      <section className="settings-card wide device-sync-card">
      <div className="settings-card-title">
        <span><Link2 size={20} /></span>
        <div><h2>Phone + laptop</h2><p>Scan two private QR codes to link the open Hush apps directly.</p></div>
        <span className={`link-status ${connected ? 'online' : ''}`}><i />{connected ? 'Live' : linkState.state === 'pairing' ? 'Pairing' : 'Offline'}</span>
      </div>

      {connected ? (
        <div className="linked-device">
          <div className="device-orbit"><Laptop size={28} /><i><Wifi size={16} /></i><Smartphone size={28} /></div>
          <div><p className="eyebrow">Direct link active</p><h3>{peerName || 'Your other Hush device'}</h3><span>{linkState.detail || 'Encrypted changes travel both ways while both apps stay open.'}</span></div>
          <button type="button" className="secondary-button" onClick={reset}><Unplug size={15} /> Disconnect</button>
        </div>
      ) : mode === 'idle' ? (
        <div className="device-sync-start">
          <div><h3>Bring Hush to your phone.</h3><p>Open Hush on both devices. Start on the device that already has your vault, then scan each QR from the other screen. No account or cloud upload is needed.</p></div>
          <div><button type="button" className="primary-button" onClick={() => { setMode('offer'); void createOfferCode() }}><Laptop size={16} /> Show link QR</button><button type="button" className="secondary-button" onClick={() => setMode('join')}><Camera size={16} /> Scan link QR</button></div>
        </div>
      ) : (
        <div className="pairing-workspace">
          <div className="pairing-steps">
            <button type="button" onClick={reset}>Back</button>
            <p className="eyebrow">{mode === 'offer' ? 'Device 1 · start here' : 'Device 2 · answer here'}</p>
            <h3>{mode === 'offer' ? 'Show, then scan.' : 'Scan, then show.'}</h3>
            <p>These one-time QR codes contain connection details, never your master password or decrypted secrets.</p>
          </div>
          {mode === 'offer' ? (
            <div className="pairing-fields">
              <div className="pairing-stage"><span>1</span><div><strong>Scan this on Device 2</strong><small>In Hush, choose Scan link QR.</small></div></div>
              {offerCode ? <PairingQr value={offerCode} label="Scan this offer with Device 2" /> : <div className="qr-preparing"><span /><p>{busy ? 'Creating a private offer…' : 'Preparing QR…'}</p></div>}
              <button type="button" className="primary-button scan-action" onClick={() => setScannerType('answer')} disabled={!offerCode || busy || answerAccepted}><Camera size={16} /> {answerAccepted ? 'Response scanned' : '2. Scan response QR'}</button>
              {answerAccepted && <p className="waiting-note"><span className="live-pip" /> Answer accepted. Waiting for the direct link…</p>}
              <details className="pairing-fallback"><summary>Use text codes instead</summary><label><span>Offer code</span><textarea readOnly value={offerCode} placeholder={busy ? 'Creating a one-time code…' : 'Create a fresh pairing code'} rows="3" /></label><button type="button" className="code-copy" onClick={() => copyCode(offerCode)} disabled={!offerCode}><Share2 size={14} /> Copy offer</button><label><span>Response from Device 2</span><textarea value={remoteCode} onChange={(event) => setRemoteCode(event.target.value)} placeholder="Paste the HUSH1 response code" rows="3" disabled={answerAccepted} /></label><button type="button" className="primary-button" onClick={() => finishPairing()} disabled={!remoteCode.trim() || busy || answerAccepted}>{busy ? 'Connecting…' : answerAccepted ? 'Answer accepted' : 'Finish linking'} {!answerAccepted && <ArrowRight size={15} />}</button></details>
            </div>
          ) : (
            <div className="pairing-fields">
              {!answerCode ? <><div className="pairing-stage"><span>1</span><div><strong>Scan Device 1</strong><small>Allow camera access when your browser asks.</small></div></div><button type="button" className="primary-button scan-action" onClick={() => setScannerType('offer')} disabled={busy}><Camera size={16} /> {busy ? 'Preparing response…' : 'Scan offer QR'}</button><details className="pairing-fallback"><summary>Paste a text code instead</summary><label><span>Offer from Device 1</span><textarea value={remoteCode} onChange={(event) => setRemoteCode(event.target.value)} placeholder="Paste the HUSH1 offer code" rows="3" /></label><button type="button" className="primary-button" onClick={() => createAnswerCode()} disabled={!remoteCode.trim() || busy}>{busy ? 'Preparing…' : 'Create response'} <ArrowRight size={15} /></button></details></> : <><div className="pairing-stage"><span>2</span><div><strong>Show this to Device 1</strong><small>Scan it there to finish the private link.</small></div></div><PairingQr value={answerCode} label="Show this response to Device 1" /><p className="waiting-note"><span className="live-pip" /> Waiting for Device 1 to scan this response…</p><details className="pairing-fallback"><summary>Use a text response instead</summary><label><span>Response code</span><textarea readOnly value={answerCode} rows="3" /></label><button type="button" className="code-copy" onClick={() => copyCode(answerCode)}><Share2 size={14} /> Copy response</button></details></>}
            </div>
          )}
        </div>
      )}
      {(error || linkState.state === 'error') && <p className="inline-error device-error"><AlertTriangle size={15} /> {error || linkState.detail}</p>}
      <div className="device-privacy"><Shield size={15} /><span>{encrypted ? 'Only ciphertext crosses the link. The other device unlocks with your existing master password.' : 'This device can receive an encrypted vault. Demo items are never sent as a real vault.'}</span></div>
      </section>
      {scannerType && <QrScannerDialog expectedType={scannerType} onClose={() => setScannerType('')} onScan={handleScannedCode} />}
    </>
  )
}

function InstallAppCard({ installed, canInstall, onInstall }) {
  return (
    <section className="settings-card install-card">
      <div className="settings-card-title"><span><Smartphone size={20} /></span><div><h2>Install the mobile app</h2><p>Keep Hush on your home screen with its own app window.</p></div></div>
      <div className="install-row"><div><strong>{installed ? 'Hush is installed' : 'Ready for your home screen'}</strong><small>{canInstall ? 'Install from this browser in one tap.' : 'On iPhone, use Share → Add to Home Screen. On Android, use Install app in the browser menu.'}</small></div><button type="button" className="secondary-button" onClick={onInstall} disabled={installed || !canInstall}><Download size={16} /> {installed ? 'Installed' : 'Install'}</button></div>
    </section>
  )
}

function SettingsView({ encrypted, autoLockMinutes, setAutoLockMinutes, clipboardClearSeconds, setClipboardClearSeconds, passwordHistoryLimit, setPasswordHistoryLimit, onExport, onRestoreFile, onChangePassword, onLock, onProtect, onLogout, deviceLink, installApp }) {
  return (
    <main className="settings-view page-enter">
      <header className="page-heading"><div><p className="eyebrow"><Settings size={14} /> Vault preferences</p><h1>Fewer switches.<br /><em>Better defaults.</em></h1><p className="heading-copy">Security choices should be understandable, not a maze of fine print.</p></div></header>
      <div className="settings-layout">
        <DeviceSyncCard encrypted={encrypted} {...deviceLink} />
        <InstallAppCard {...installApp} />
        <section className="settings-card">
          <div className="settings-card-title"><span><LockKeyhole size={20} /></span><div><h2>Vault access</h2><p>Lock this vault, or remove its local copy to switch vaults.</p></div></div>
          <label className="setting-row"><span><strong>Lock after</strong><small>Mouse and keyboard activity reset the timer.</small></span><select value={autoLockMinutes} onChange={(event) => setAutoLockMinutes(Number(event.target.value))}><option value={5}>5 minutes</option><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={0}>Never</option></select></label>
          <label className="setting-row"><span><strong>Password history</strong><small>Previous values remain inside the encrypted vault.</small></span><select value={passwordHistoryLimit} onChange={(event) => setPasswordHistoryLimit(Number(event.target.value))}><option value={0}>Off</option><option value={3}>3 versions</option><option value={5}>5 versions</option><option value={10}>10 versions</option></select></label>
          <button className="settings-action" type="button" onClick={encrypted ? onLock : onProtect}><Lock size={16} /> {encrypted ? 'Lock right now' : 'Create a protected vault'}<ArrowRight size={16} /></button>
          {encrypted && <button className="settings-action" type="button" onClick={onChangePassword}><KeyRound size={16} /> Change master password<ChevronRight size={16} /></button>}
          {encrypted && <button className="settings-action logout-action" type="button" onClick={onLogout}><LogOut size={16} /> Log out on this device<ChevronRight size={16} /></button>}
        </section>
        <section className="settings-card">
          <div className="settings-card-title"><span><Copy size={20} /></span><div><h2>Clipboard care</h2><p>Copied secrets are cleared on a configurable timer.</p></div></div>
          <label className="setting-row"><span><strong>Clear copied secrets</strong><small>Best effort when browser permissions allow.</small></span><select value={clipboardClearSeconds} onChange={(event) => setClipboardClearSeconds(Number(event.target.value))}><option value={15}>After 15 seconds</option><option value={30}>After 30 seconds</option><option value={60}>After 1 minute</option><option value={120}>After 2 minutes</option></select></label>
          <div className="honest-note"><Info size={16} /><p>Clipboard history tools may retain copied values. Prefer extension autofill when available; Hush never copies silently.</p></div>
        </section>
        <section className="settings-card wide">
          <div className="settings-card-title"><span><Database size={20} /></span><div><h2>Encrypted backup</h2><p>Export or restore the authenticated encrypted envelope—never a plaintext password list.</p></div></div>
          <div className="backup-row"><div><span className={`backup-badge ${encrypted ? 'ready' : ''}`}><HardDrive size={17} /> {encrypted ? 'Encrypted backup ready' : 'Restore an existing backup'}</span><small>Includes the format version, Argon2id parameters, wrapped vault key, ciphertext, recovery wrap, and integrity metadata.</small></div><div className="backup-actions"><button type="button" className="secondary-button" onClick={onExport} disabled={!encrypted}><Download size={16} /> Download .hush</button><label className="secondary-button file-button"><FileUp size={16} /> Restore .hush<input type="file" accept=".hush,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) onRestoreFile(file); event.target.value = '' }} /></label></div></div>
        </section>
        <section className="settings-card wide technical"><p className="eyebrow">Technical note</p><h2>Memory-hard key derivation. Authenticated encryption.</h2><div><span><strong>AES-256-GCM</strong><small>Unique nonces + authenticated metadata</small></span><span><strong>Argon2id</strong><small>{Math.round(ARGON2_PARAMS.memorySize / 1024)} MiB · {ARGON2_PARAMS.iterations} passes · p={ARGON2_PARAMS.parallelism}</small></span><span><strong>KEK → DEK</strong><small>Master-password changes only rewrap the vault key</small></span><span><strong>Local only</strong><small>No analytics or remote vault scripts</small></span></div></section>
      </div>
    </main>
  )
}

function EntryEditor({ entry, onClose, onSave, onCopy }) {
  const savingRef = useRef(false)
  const closeIfIdle = () => { if (!savingRef.current) onClose() }
  const dialogRef = useDialogFocus(closeIfIdle)
  const [form, setForm] = useState(() => ({ ...emptyEntry, ...(entry || {}) }))
  const [showPassword, setShowPassword] = useState(false)
  const [generator, setGenerator] = useState({ ...GENERATOR_DEFAULTS, mode: 'password', words: 8, allowedCharacters: '' })
  const [generatorError, setGeneratorError] = useState('')
  const [saving, setSaving] = useState(false)
  const isEdit = Boolean(entry?.id)
  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }))
  const updateGenerator = (field, value) => setGenerator((current) => ({ ...current, [field]: value }))

  function regenerate() {
    try {
      const password = generator.mode === 'passphrase'
        ? generatePassphrase({ words: generator.words, separator: '-', includeNumber: true })
        : generatePassword(generator)
      update('password', password)
      setGeneratorError('')
    } catch (error) {
      setGeneratorError(error.message || 'Could not generate a password with those rules.')
    }
  }

  async function submit(event) {
    event.preventDefault()
    if (savingRef.current || !form.name.trim() || !form.password) return
    savingRef.current = true
    setSaving(true)
    try {
      await onSave({ ...form, name: form.name.trim(), username: form.username.trim(), url: form.url.trim() })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeIfIdle()}>
      <form ref={dialogRef} className="editor-sheet modal-enter" onSubmit={submit} role="dialog" aria-modal="true" aria-label={isEdit ? `Edit ${entry.name}` : 'Add a new secret'}>
        <header><div><p className="eyebrow">{isEdit ? 'Edit secret' : 'Fresh secret'}</p><h2>{isEdit ? 'Tidy up the details.' : 'Put something away.'}</h2></div><button type="button" className="icon-button" onClick={closeIfIdle} aria-label="Close" disabled={saving}><X size={19} /></button></header>
        <div className="editor-body">
          <label className="input-field"><span>Name <b>Required</b></span><input autoFocus value={form.name} onChange={(event) => update('name', event.target.value)} placeholder="e.g. Are.na" required /></label>
          <label className="input-field"><span>Username or email</span><input value={form.username} onChange={(event) => update('username', event.target.value)} placeholder="name@example.com" autoComplete="off" /></label>
          <div className="secret-value-block">
            <label className="input-field" htmlFor="entry-secret"><span>Password <b>Required</b></span></label>
            <div className="secret-value-input"><input id="entry-secret" name="password" type={showPassword ? 'text' : 'password'} value={form.password} onChange={(event) => update('password', event.target.value)} placeholder="Add or generate a password" autoComplete="new-password" required /><button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={19} /> : <Eye size={19} />}</button></div>
            <div className="generator-panel">
              <div className="generator-top"><WandSparkles size={17} /><strong>Hush Generator</strong><select value={generator.mode} onChange={(event) => updateGenerator('mode', event.target.value)}><option value="password">Password</option><option value="passphrase">Passphrase</option></select></div>
              {generator.mode === 'password' ? <>
                <label className="generator-range"><span>Length</span><input type="range" min="12" max="64" value={generator.length} onChange={(event) => updateGenerator('length', Number(event.target.value))} /><b>{generator.length}</b></label>
                <div className="generator-checks">{[['lowercase', 'Lowercase'], ['uppercase', 'Uppercase'], ['numbers', 'Numbers'], ['symbols', 'Symbols'], ['avoidAmbiguous', 'Avoid ambiguous']].map(([key, label]) => <label key={key}><input type="checkbox" checked={generator[key]} onChange={(event) => updateGenerator(key, event.target.checked)} /><span>{label}</span></label>)}</div>
                <label className="generator-restrictions"><span>Site-allowed characters <small>Optional</small></span><input value={generator.allowedCharacters} onChange={(event) => updateGenerator('allowedCharacters', event.target.value)} placeholder="Leave blank unless the site restricts characters" /></label>
              </> : <label className="generator-range"><span>Words</span><input type="range" min="5" max="12" value={generator.words} onChange={(event) => updateGenerator('words', Number(event.target.value))} /><b>{generator.words}</b></label>}
              <div className="generator-actions"><button type="button" onClick={regenerate}><Zap size={15} /> {form.password ? 'Regenerate' : 'Generate'}</button>{form.password && <button type="button" onClick={() => onCopy('Generated password', form.password)}><Copy size={15} /> Copy</button>}<span className={`strength-mini ${passwordHealth({ password: form.password }, new Map()).tone}`}>{form.password ? `${passwordHealth({ password: form.password }, new Map()).label} · ${passwordHealth({ password: form.password }, new Map()).value}%` : 'Local only'}</span></div>
              {generatorError && <p className="generator-error" role="alert">{generatorError}</p>}
            </div>
          </div>
          <label className="input-field"><span>Website</span><input value={form.url} onChange={(event) => update('url', event.target.value)} placeholder="https://example.com" inputMode="url" /></label>
          <div className="editor-pair"><label className="input-field"><span>Collection</span><select value={form.collection} onChange={(event) => update('collection', event.target.value)}><option>Personal</option><option>Work</option><option>Finance</option><option>Home</option><option>Travel</option><option>Imported</option></select></label><label className="favorite-check"><input type="checkbox" checked={form.favorite} onChange={(event) => update('favorite', event.target.checked)} /><span><Star size={17} fill={form.favorite ? 'currentColor' : 'none'} /></span><strong>Favorite</strong></label></div>
          <label className="input-field"><span>Private note</span><textarea value={form.notes} onChange={(event) => update('notes', event.target.value)} placeholder="Anything useful to remember…" rows="4" /></label>
        </div>
        <footer><button type="button" className="secondary-button" onClick={closeIfIdle} disabled={saving}>Cancel</button><button type="submit" className="primary-button" disabled={saving || !form.name.trim() || !form.password}>{saving ? 'Encrypting…' : isEdit ? 'Save changes' : 'Add to vault'} {!saving && <ArrowRight size={16} />}</button></footer>
      </form>
    </div>
  )
}

function DeleteDialog({ entry, onClose, onConfirm }) {
  const dialogRef = useDialogFocus(onClose)
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section ref={dialogRef} className="confirm-dialog modal-enter" role="alertdialog" aria-modal="true" aria-labelledby="delete-title"><span className="danger-mark"><Trash2 size={22} /></span><p className="eyebrow">Delete secret</p><h2 id="delete-title">Remove {entry.name}?</h2><p>This permanently removes the item from the encrypted vault. This action cannot be undone.</p><div><button type="button" className="secondary-button" onClick={onClose}>Keep it</button><button type="button" className="danger-button" onClick={onConfirm}>Delete permanently</button></div></section></div>
}

function LogoutDialog({ onClose, onConfirm, busy }) {
  const dialogRef = useDialogFocus(onClose)
  const [confirmation, setConfirmation] = useState('')
  const ready = confirmation.trim().toUpperCase() === 'REMOVE'
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}><section ref={dialogRef} className="confirm-dialog logout-dialog modal-enter" role="alertdialog" aria-modal="true" aria-labelledby="logout-title"><span className="danger-mark"><LogOut size={22} /></span><p className="eyebrow">Log out on this device</p><h2 id="logout-title">Remove the local vault?</h2><p>This permanently deletes this device’s encrypted copy and returns Hush to the welcome screen, so you can create or link a different vault. Other devices are not erased.</p><div className="logout-warning"><Info size={16} /><span>Download an encrypted archive first if this is your only copy.</span></div><label className="input-field"><span>Type REMOVE to confirm</span><input autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck="false" /></label><div className="confirm-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Keep this vault</button><button type="button" className="danger-button" onClick={onConfirm} disabled={!ready || busy}>{busy ? 'Removing…' : 'Log out & remove'}</button></div></section></div>
}

function RecoveryKeyDialog({ recoveryKey, onCopy, onClose }) {
  const dialogRef = useDialogFocus(() => {})
  const [confirmed, setConfirmed] = useState(false)
  return <div className="modal-backdrop"><section ref={dialogRef} className="confirm-dialog recovery-key-dialog modal-enter" role="dialog" aria-modal="true" aria-labelledby="recovery-key-title"><span className="safe-mark"><FileKey2 size={22} /></span><p className="eyebrow">One-time recovery key</p><h2 id="recovery-key-title">Save this somewhere safe.</h2><p>Hush will never show this key again. It can reset a forgotten master password, but anyone who has it and your encrypted vault can unlock the vault.</p><code className="recovery-key-value">{recoveryKey}</code><button type="button" className="secondary-button" onClick={() => onCopy('Recovery key', recoveryKey)}><Copy size={16} /> Copy recovery key</button><label className="keep-samples recovery-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span><Check size={13} /></span><div><strong>I saved the key</strong><small>I understand Hush cannot retrieve it later.</small></div></label><button type="button" className="primary-button full-button" disabled={!confirmed} onClick={onClose}>Continue to my vault <ArrowRight size={16} /></button></section></div>
}

function ChangePasswordDialog({ onClose, onConfirm, busy }) {
  const dialogRef = useDialogFocus(onClose)
  const [currentPassword, setCurrentPassword] = useState('')
  const [nextPassword, setNextPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const health = useMemo(() => masterPasswordHealth(nextPassword), [nextPassword])
  async function submit(event) {
    event.preventDefault()
    if (!health.acceptable) return setError('Use at least 14 characters and avoid predictable words, names, sequences, and dates.')
    if (nextPassword !== confirmation) return setError('The new passwords do not match.')
    try {
      setError('')
      await onConfirm(currentPassword, nextPassword)
    } catch (changeError) {
      setError(changeError.message || 'Could not change the master password.')
    }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}><form ref={dialogRef} className="confirm-dialog credential-dialog modal-enter" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="change-password-title"><span className="safe-mark"><KeyRound size={22} /></span><p className="eyebrow">Rewrap vault key</p><h2 id="change-password-title">Change master password</h2><p>Your credentials are not re-encrypted. Hush verifies the current password and securely wraps the same random vault key with the new one.</p><label className="input-field"><span>Current master password</span><input autoFocus type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" /></label><label className="input-field"><span>New master password</span><input type="password" value={nextPassword} onChange={(event) => setNextPassword(event.target.value)} autoComplete="new-password" /></label><div className="password-meter"><i style={{ width: `${health.value}%` }} /><span>{health.label}</span></div><label className="input-field"><span>Confirm new password</span><input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" /></label>{error && <p className="inline-error" role="alert"><AlertTriangle size={15} /> {error}</p>}<div className="confirm-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="primary-button" disabled={busy || !currentPassword || !health.acceptable || nextPassword !== confirmation}>{busy ? 'Rewrapping…' : 'Change password'}</button></div></form></div>
}

function RecoverVaultDialog({ onClose, onConfirm, busy }) {
  const dialogRef = useDialogFocus(onClose)
  const [recoveryKey, setRecoveryKey] = useState('')
  const [nextPassword, setNextPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const health = useMemo(() => masterPasswordHealth(nextPassword), [nextPassword])
  async function submit(event) {
    event.preventDefault()
    if (!health.acceptable) return setError('Choose a stronger replacement master password.')
    if (nextPassword !== confirmation) return setError('The new passwords do not match.')
    try {
      setError('')
      await onConfirm(recoveryKey, nextPassword)
    } catch (recoverError) {
      setError(recoverError.message || 'That recovery key could not unlock this vault.')
    }
  }
  return <div className="modal-backdrop"><form ref={dialogRef} className="confirm-dialog credential-dialog modal-enter" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="recover-title"><span className="safe-mark"><FileKey2 size={22} /></span><p className="eyebrow">Offline recovery</p><h2 id="recover-title">Use your recovery key</h2><p>The key is checked locally. A successful recovery immediately replaces the old master-password wrap.</p><label className="input-field"><span>Recovery key</span><textarea autoFocus rows="3" value={recoveryKey} onChange={(event) => setRecoveryKey(event.target.value)} spellCheck="false" autoComplete="off" /></label><label className="input-field"><span>New master password</span><input type="password" value={nextPassword} onChange={(event) => setNextPassword(event.target.value)} autoComplete="new-password" /></label><label className="input-field"><span>Confirm new password</span><input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" /></label>{error && <p className="inline-error" role="alert"><AlertTriangle size={15} /> {error}</p>}<div className="confirm-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="primary-button" disabled={busy || !recoveryKey || !health.acceptable || nextPassword !== confirmation}>{busy ? 'Recovering…' : 'Recover vault'}</button></div></form></div>
}

function RestoreDialog({ file, replacing, onClose, onConfirm, busy }) {
  const dialogRef = useDialogFocus(onClose)
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const ready = Boolean(password) && (!replacing || confirmation.trim().toUpperCase() === 'REPLACE')
  async function submit(event) {
    event.preventDefault()
    try {
      setError('')
      await onConfirm(password)
    } catch (restoreError) {
      setError(restoreError.message || 'Could not authenticate and restore that backup.')
    }
  }
  return <div className="modal-backdrop"><form ref={dialogRef} className="confirm-dialog credential-dialog modal-enter" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="restore-title"><span className="safe-mark"><FileUp size={22} /></span><p className="eyebrow">Authenticated restore</p><h2 id="restore-title">Restore {file.name}</h2><p>Hush will authenticate the encrypted backup before storing it. No plaintext is imported from an unauthenticated file.</p><label className="input-field"><span>Backup master password</span><input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>{replacing && <label className="input-field"><span>Type REPLACE to overwrite this device’s local vault</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck="false" /></label>}{error && <p className="inline-error" role="alert"><AlertTriangle size={15} /> {error}</p>}<div className="confirm-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="primary-button" disabled={busy || !ready}>{busy ? 'Authenticating…' : 'Restore encrypted vault'}</button></div></form></div>
}

function Onboarding({ onClose, onCreate, onLink, busy, sampleCount }) {
  const dialogRef = useDialogFocus(onClose)
  const [mode, setMode] = useState('welcome')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [keepSamples, setKeepSamples] = useState(true)
  const [error, setError] = useState('')
  const masterHealth = useMemo(() => masterPasswordHealth(password), [password])
  const ready = masterHealth.acceptable && password === confirm

  async function submit(event) {
    event.preventDefault()
    if (!masterHealth.acceptable) return setError('Use a stronger master password—at least 14 characters and avoid common words, obvious sequences, repeated patterns, or dates.')
    if (password !== confirm) return setError('Those passwords do not match yet.')
    setError('')
    try {
      await onCreate(password, keepSamples)
    } catch (createError) {
      setError(createError.message || 'This browser could not create the encrypted vault.')
    }
  }

  const masterLabel = !password
    ? 'Start with a long passphrase'
    : password.length < 14
      ? 'Keep going'
      : !masterHealth.acceptable
        ? 'Too predictable'
        : masterHealth.value < 80
          ? 'Good'
          : masterHealth.value < 95
            ? 'Strong'
            : 'Excellent'

  return (
    <div className="onboarding-backdrop">
      <section ref={dialogRef} className="onboarding-card modal-enter" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <div className="onboarding-visual"><div className="onboarding-seal"><BrandMark decorative={false} /></div><div className="seal-line" /><p>PRIVATE BY DESIGN<br />LOCAL BY DEFAULT</p><span className="visual-orbit orbit-one" /><span className="visual-orbit orbit-two" /></div>
        {mode === 'welcome' ? (
          <div className="onboarding-copy">
            <p className="eyebrow"><span className="live-pip" /> Welcome to hush</p>
            <h1 id="onboarding-title">A quieter place for<br /><em>the important things.</em></h1>
            <p>Explore a polished sample vault, or protect it now with a master password. Your encrypted vault stays inside this browser.</p>
            <div className="promise-list"><span><ShieldCheck size={18} /><strong>AES-256-GCM encryption</strong></span><span><HardDrive size={18} /><strong>No account. No upload.</strong></span><span><Sparkles size={18} /><strong>Import any CSV your way</strong></span></div>
            <div className="onboarding-actions"><button type="button" className="primary-button" onClick={() => setMode('create')}>Create encrypted vault <ArrowRight size={17} /></button><button type="button" className="secondary-button" onClick={onLink}><Link2 size={16} /> Link my other device</button><button type="button" className="text-button" onClick={onClose}>Explore sample</button></div>
          </div>
        ) : (
          <form className="onboarding-copy create-form" onSubmit={submit}>
            <button type="button" className="form-back" onClick={() => setMode('welcome')}>← Back</button>
            <p className="eyebrow"><LockKeyhole size={14} /> Create your vault</p>
            <h1 id="onboarding-title">Choose the one key<br /><em>only you will know.</em></h1>
            <p>Use a long memorable passphrase. Hush will create a one-time recovery key for you to save offline.</p>
            <label className="input-field"><span>Master password</span><input id="new-master-password" autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" placeholder="A long, memorable phrase" aria-describedby="password-guidance password-strength" aria-invalid={Boolean(error && !masterHealth.acceptable)} /></label>
            <div className="password-meter" id="password-strength" aria-live="polite"><i style={{ width: `${masterHealth.value}%` }} /><span>{masterLabel}</span></div>
            <p id="password-guidance" className="visually-hidden">Use at least 14 characters and avoid predictable words, sequences, repeated patterns, and dates. A longer memorable passphrase is recommended.</p>
            <label className="input-field"><span>Confirm password</span><input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" placeholder="Type it once more" aria-describedby={(error || (confirm && password !== confirm)) ? 'create-password-error' : undefined} aria-invalid={Boolean(confirm && password !== confirm)} /></label>
            {sampleCount > 0 && <label className="keep-samples"><input type="checkbox" checked={keepSamples} onChange={(event) => setKeepSamples(event.target.checked)} /><span><Check size={13} /></span><div><strong>Keep {sampleCount} sample {sampleCount === 1 ? 'item' : 'items'}</strong><small>Your own demo additions are kept either way.</small></div></label>}
            {(error || (confirm && password !== confirm)) && <p className="inline-error" id="create-password-error" role="alert"><AlertTriangle size={15} /> {error || 'Those passwords do not match yet.'}</p>}
            <button type="submit" className="primary-button full-button" disabled={!ready || busy}>{busy ? 'Encrypting locally…' : 'Create my vault'} <LockKeyhole size={17} /></button>
          </form>
        )}
      </section>
    </div>
  )
}

function LockScreen({ onUnlock, onRecover, onLogout, busy, notice }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  async function submit(event) {
    event.preventDefault()
    setError('')
    try {
      await onUnlock(password)
    } catch {
      setError('Couldn’t unlock this vault. Check your master password.')
    }
  }
  return (
    <main className="lock-screen">
      <div className="lock-grain" />
      <div className="lock-brand"><span className="lock-seal"><BrandMark decorative={false} /></span><strong>hush.</strong><small>PRIVATE VAULT</small></div>
      <form className="unlock-card" onSubmit={submit}>
        {notice && <p className="lock-notice"><Smartphone size={15} /> {notice}</p>}
        <p className="eyebrow"><span className="live-pip" /> Vault sealed</p>
        <h1>Welcome back.<br /><em>Let yourself in.</em></h1>
        <div className="unlock-field"><label htmlFor="unlock-password">Master password</label><div className="unlock-input"><LockKeyhole size={18} /><input id="unlock-password" autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" autoComplete="current-password" aria-describedby={error ? 'unlock-note unlock-error' : 'unlock-note'} aria-invalid={Boolean(error)} /><button type="submit" disabled={!password || busy} aria-label="Unlock vault"><ArrowRight size={19} /></button></div></div>
        {error && <p className="unlock-error" id="unlock-error" role="alert"><AlertTriangle size={15} /> {error}</p>}
        <p className="unlock-note" id="unlock-note"><Shield size={15} /> Decryption happens only in this browser.</p>
        <button type="button" className="lock-switch-vault" onClick={onRecover}><FileKey2 size={14} /> Recover with saved key</button>
        <button type="button" className="lock-switch-vault" onClick={onLogout}><LogOut size={14} /> Use a different vault</button>
      </form>
      <div className="lock-footer"><span>OFFLINE RECOVERY KEY</span><span>ARGON2ID · AES-256-GCM</span><span>LOCAL VAULT / 02</span></div>
    </main>
  )
}

export default function App({ vaultApi = defaultVaultApi, runtime = 'web' }) {
  const {
    changeMasterPassword,
    createVault,
    applyTransferredVault,
    deleteStoredVault,
    hasStoredVault,
    installTransferredVault,
    openVaultEnvelope,
    persistVault,
    readStoredVault,
    recoverVault,
    restoreVaultArchive,
    unlockVault,
    unlockVaultEnvelope,
  } = vaultApi
  const [status, setStatus] = useState('checking')
  const [entries, setEntries] = useState([])
  const [envelope, setEnvelope] = useState(null)
  const [view, setView] = useState('vault')
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState('sample-linear')
  const [editorEntry, setEditorEntry] = useState(undefined)
  const [editorOpen, setEditorOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState(null)
  const [clipboardState, setClipboardState] = useState(null)
  const [autoLockMinutes, setAutoLockMinutes] = useState(15)
  const [clipboardClearSeconds, setClipboardClearSeconds] = useState(30)
  const [passwordHistoryLimit, setPasswordHistoryLimit] = useState(5)
  const [recoveryKeyDisplay, setRecoveryKeyDisplay] = useState('')
  const [changePasswordOpen, setChangePasswordOpen] = useState(false)
  const [recoverOpen, setRecoverOpen] = useState(false)
  const [restoreFile, setRestoreFile] = useState(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [linkState, setLinkState] = useState({ state: 'idle', detail: '' })
  const [peerName, setPeerName] = useState('')
  const [lockNotice, setLockNotice] = useState('')
  const [installPrompt, setInstallPrompt] = useState(null)
  const [appInstalled, setAppInstalled] = useState(() => window.matchMedia?.('(display-mode: standalone)').matches || Boolean(navigator.standalone))
  const copiedValueRef = useRef('')
  const searchRef = useRef(null)
  const dataKeyRef = useRef(null)
  const envelopeRef = useRef(null)
  const entriesRef = useRef([])
  const committedEntriesRef = useRef([])
  const sessionRef = useRef(0)
  const writeQueueRef = useRef(Promise.resolve())
  const linkRef = useRef(null)
  const statusRef = useRef(status)
  const pendingIncomingRef = useRef(null)
  const lastSessionTouchRef = useRef(0)

  const encrypted = status === 'unlocked'
  statusRef.current = status

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const resumed = await vaultApi.resumeVault?.()
        if (!active) return
        if (resumed) {
          const resumedItems = normalizePasswordDates(resumed.payload.items)
          sessionRef.current += 1
          dataKeyRef.current = resumed.dataKey
          envelopeRef.current = resumed.envelope
          entriesRef.current = resumedItems
          committedEntriesRef.current = resumedItems
          setEnvelope(resumed.envelope)
          setEntries(resumedItems)
          applyPreferences(resumed.payload.preferences)
          setSelectedId(resumedItems[0]?.id || '')
          setStatus('unlocked')
          return
        }
        const exists = await hasStoredVault()
        if (!active) return
        if (exists) {
          setStatus('locked')
          return
        }
        const demoEntries = normalizePasswordDates(sampleEntries)
        entriesRef.current = demoEntries
        committedEntriesRef.current = demoEntries
        setEntries(demoEntries)
        setStatus('demo')
        setOnboardingOpen(true)
      } catch {
        if (!active) return
        const demoEntries = normalizePasswordDates(sampleEntries)
        entriesRef.current = demoEntries
        committedEntriesRef.current = demoEntries
        setEntries(demoEntries)
        setStatus('demo')
        setOnboardingOpen(true)
      }
    })()
    return () => { active = false }
  }, [vaultApi])

  useEffect(() => {
    function handleShortcut(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setView('vault')
        requestAnimationFrame(() => searchRef.current?.focus())
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [])

  useEffect(() => {
    if (status !== 'unlocked' || autoLockMinutes === 0) return undefined
    let timer
    let lastActiveAt = Date.now()
    const reset = () => {
      lastActiveAt = Date.now()
      if (runtime === 'extension' && vaultApi.touchSession && Date.now() - lastSessionTouchRef.current >= 30_000) {
        lastSessionTouchRef.current = Date.now()
        void vaultApi.touchSession().catch(() => lockVault({ notifyBackend: false }))
      }
      window.clearTimeout(timer)
      timer = window.setTimeout(() => lockVault(), autoLockMinutes * 60_000)
    }
    const checkWake = () => {
      if (Date.now() - lastActiveAt >= autoLockMinutes * 60_000) lockVault()
    }
    const events = ['pointerdown', 'keydown']
    events.forEach((event) => window.addEventListener(event, reset, { passive: true }))
    document.addEventListener('visibilitychange', checkWake)
    window.addEventListener('focus', checkWake)
    reset()
    return () => {
      window.clearTimeout(timer)
      events.forEach((event) => window.removeEventListener(event, reset))
      document.removeEventListener('visibilitychange', checkWake)
      window.removeEventListener('focus', checkWake)
    }
  }, [status, autoLockMinutes, runtime, vaultApi])

  useEffect(() => {
    if (runtime !== 'extension' || status !== 'unlocked' || !vaultApi.status) return undefined
    const poll = window.setInterval(() => {
      void vaultApi.status()
        .then((current) => { if (!current.unlocked) lockVault({ notifyBackend: false }) })
        .catch(() => lockVault({ notifyBackend: false }))
    }, 10_000)
    return () => window.clearInterval(poll)
  }, [runtime, status, vaultApi])

  useEffect(() => {
    if (!clipboardState?.id) return undefined
    const copyId = clipboardState.id
    const copiedValue = copiedValueRef.current
    const tick = async () => {
      const remaining = Math.max(0, Math.ceil((clipboardState.deadline - Date.now()) / 1000))
      if (remaining > 0) {
        setClipboardState((current) => current?.id === copyId ? { ...current, remaining } : current)
        return
      }
      window.clearInterval(timer)
      await clearClipboardIfMatches(copiedValue)
      if (copiedValueRef.current === copiedValue) copiedValueRef.current = ''
      setClipboardState((current) => current?.id === copyId ? null : current)
    }
    const timer = window.setInterval(tick, 500)
    tick()
    return () => window.clearInterval(timer)
  }, [clipboardState?.id])

  useEffect(() => {
    function captureInstallPrompt(event) {
      event.preventDefault()
      setInstallPrompt(event)
    }
    function markInstalled() {
      setAppInstalled(true)
      setInstallPrompt(null)
    }
    window.addEventListener('beforeinstallprompt', captureInstallPrompt)
    window.addEventListener('appinstalled', markInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', captureInstallPrompt)
      window.removeEventListener('appinstalled', markInstalled)
    }
  }, [])

  useEffect(() => {
    const deviceLink = createDeviceLink({
      onState: setLinkState,
      onPeer: setPeerName,
      onEnvelope: (incoming) => { void handleIncomingEnvelope(incoming) },
    })
    linkRef.current = deviceLink
    return () => {
      deviceLink.close(false)
      linkRef.current = null
    }
  }, [])

  useEffect(() => {
    if (encrypted && envelope) linkRef.current?.shareEnvelope(envelope)
  }, [encrypted, envelope])

  function showToast(message, tone = 'success') {
    setToast({ message, tone, id: Date.now() })
    window.setTimeout(() => setToast((current) => current?.message === message ? null : current), 2600)
  }

  function applyPreferences(preferences) {
    const normalized = normalizePreferences(preferences)
    setAutoLockMinutes(normalized.autoLockMinutes)
    setClipboardClearSeconds(normalized.clipboardClearSeconds)
    setPasswordHistoryLimit(normalized.passwordHistoryLimit)
    return normalized
  }

  function currentPreferences(overrides = {}) {
    return normalizePreferences({ autoLockMinutes, clipboardClearSeconds, passwordHistoryLimit, ...overrides })
  }

  async function handleIncomingEnvelope(incoming) {
    try {
      await writeQueueRef.current.catch(() => {})
      const local = await readStoredVault()
      if (!local) {
        pendingIncomingRef.current = incoming
        sessionRef.current += 1
        dataKeyRef.current = null
        envelopeRef.current = null
        entriesRef.current = []
        committedEntriesRef.current = []
        setEnvelope(null)
        setEntries([])
        setOnboardingOpen(false)
        setLockNotice('Encrypted vault received. Unlock with the same master password to authenticate and save it here.')
        statusRef.current = 'locked'
        setStatus('locked')
        setLinkState({ state: 'connected', detail: 'Encrypted vault received' })
        return
      }
      if (!sameVault(local, incoming)) {
        setLinkState({ state: 'error', detail: 'These devices contain different vaults, so Hush did not overwrite either one.' })
        return
      }
      const comparison = compareEnvelopeVersions(incoming, local)
      if (comparison < 0) {
        linkRef.current?.shareEnvelope(local)
        return
      }
      if (comparison === 0) return

      const key = dataKeyRef.current
      if (!key || statusRef.current !== 'unlocked') {
        pendingIncomingRef.current = incoming
        setLockNotice('Encrypted changes are waiting. Unlock Hush to authenticate and apply them.')
        setLinkState({ state: 'connected', detail: 'Encrypted changes waiting for unlock' })
        return
      }
      const payload = await openVaultEnvelope(key, incoming)
      await applyTransferredVault(local.revision || 0, incoming)
      const syncedItems = normalizePasswordDates(payload.items)
      envelopeRef.current = incoming
      entriesRef.current = syncedItems
      committedEntriesRef.current = syncedItems
      setEnvelope(incoming)
      setEntries(syncedItems)
      applyPreferences(payload.preferences)
      setSelectedId((current) => syncedItems.some((entry) => entry.id === current) ? current : syncedItems[0]?.id || '')
      showToast('Encrypted changes received from your other device')
      setLinkState({ state: 'connected', detail: 'Encrypted vault synced just now' })
    } catch (error) {
      setLinkState({ state: 'error', detail: mutationErrorMessage(error, 'Could not apply the linked vault safely.') })
    }
  }

  async function installCurrentApp() {
    if (!installPrompt) return
    await installPrompt.prompt()
    const choice = await installPrompt.userChoice
    if (choice.outcome === 'accepted') setInstallPrompt(null)
  }

  async function createEncryptedVault(password, keepSamples) {
    setBusy(true)
    try {
      const currentEntries = entriesRef.current
      const nextItems = keepSamples ? currentEntries : currentEntries.filter((entry) => !entry.id.startsWith('sample-'))
      const payload = { schemaVersion: 2, items: nextItems, preferences: currentPreferences() }
      const created = await createVault(password, payload)
      sessionRef.current += 1
      dataKeyRef.current = created.dataKey
      envelopeRef.current = created.envelope
      entriesRef.current = nextItems
      committedEntriesRef.current = nextItems
      setEnvelope(created.envelope)
      setEntries(nextItems)
      setSelectedId(nextItems[0]?.id || '')
      setStatus('unlocked')
      setLockNotice('')
      setOnboardingOpen(false)
      setRecoveryKeyDisplay(created.recoveryKey || '')
      showToast('Encrypted vault created')
    } finally {
      setBusy(false)
    }
  }

  async function unlock(password) {
    setBusy(true)
    try {
      await writeQueueRef.current.catch(() => {})
      const stored = await readStoredVault()
      const waiting = pendingIncomingRef.current
      const receivingFirstVault = !stored && Boolean(waiting)
      const opened = receivingFirstVault
        ? await unlockVaultEnvelope(password, waiting)
        : await unlockVault(password)
      if (receivingFirstVault) {
        await installTransferredVault(opened.envelope)
        pendingIncomingRef.current = null
      }
      let nextEnvelope = opened.envelope
      let nextPayload = opened.payload
      const pending = receivingFirstVault ? null : pendingIncomingRef.current
      pendingIncomingRef.current = null
      if (pending && sameVault(opened.envelope, pending) && compareEnvelopeVersions(pending, opened.envelope) > 0) {
        try {
          nextPayload = await openVaultEnvelope(opened.dataKey, pending)
          await applyTransferredVault(opened.envelope.revision || 0, pending)
          nextEnvelope = pending
          setLinkState({ state: 'connected', detail: 'Waiting changes authenticated and synced' })
        } catch {
          setLinkState({ state: 'error', detail: 'Waiting device changes failed authentication and were not stored.' })
        }
      }
      sessionRef.current += 1
      dataKeyRef.current = opened.dataKey
      envelopeRef.current = nextEnvelope
      const openedItems = normalizePasswordDates(nextPayload.items)
      entriesRef.current = openedItems
      committedEntriesRef.current = openedItems
      setEnvelope(nextEnvelope)
      setEntries(openedItems)
      applyPreferences(nextPayload.preferences)
      setSelectedId(openedItems[0]?.id || '')
      setStatus('unlocked')
      setLockNotice('')
    } finally {
      setBusy(false)
    }
  }

  function lockVault({ notifyBackend = true } = {}) {
    if (status === 'demo') {
      setOnboardingOpen(true)
      return
    }
    if (notifyBackend) void vaultApi.lockVault?.().catch(() => {})
    const copiedValue = copiedValueRef.current
    copiedValueRef.current = ''
    setClipboardState(null)
    void clearClipboardIfMatches(copiedValue)
    sessionRef.current += 1
    dataKeyRef.current = null
    envelopeRef.current = null
    entriesRef.current = []
    committedEntriesRef.current = []
    setEnvelope(null)
    setEntries([])
    setSearch('')
    setSelectedId('')
    setEditorOpen(false)
    setView('vault')
    setStatus('locked')
  }

  async function logoutFromDevice() {
    setBusy(true)
    try {
      await writeQueueRef.current.catch(() => {})
      await deleteStoredVault()
      const copiedValue = copiedValueRef.current
      copiedValueRef.current = ''
      setClipboardState(null)
      void clearClipboardIfMatches(copiedValue)
      sessionRef.current += 1
      writeQueueRef.current = Promise.resolve()
      linkRef.current?.shareEnvelope(null)
      linkRef.current?.close()
      pendingIncomingRef.current = null
      dataKeyRef.current = null
      envelopeRef.current = null
      const demoEntries = normalizePasswordDates(sampleEntries)
      entriesRef.current = demoEntries
      committedEntriesRef.current = demoEntries
      statusRef.current = 'demo'
      setEnvelope(null)
      setEntries(demoEntries)
      setSelectedId(demoEntries[0]?.id || '')
      setSearch('')
      setFilter('all')
      setView('vault')
      setEditorOpen(false)
      setDeleteTarget(null)
      setLockNotice('')
      setPeerName('')
      setLinkState({ state: 'idle', detail: '' })
      setAutoLockMinutes(DEFAULT_PREFERENCES.autoLockMinutes)
      setClipboardClearSeconds(DEFAULT_PREFERENCES.clipboardClearSeconds)
      setPasswordHistoryLimit(DEFAULT_PREFERENCES.passwordHistoryLimit)
      setLogoutOpen(false)
      setStatus('demo')
      setOnboardingOpen(true)
    } catch (error) {
      showToast(mutationErrorMessage(error, 'Could not remove the vault from this device.'), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function queueEncryptedSnapshot(nextEntries, preferences = currentPreferences()) {
    const session = sessionRef.current
    const key = dataKeyRef.current
    const operation = writeQueueRef.current.catch(() => {}).then(async () => {
      if (session !== sessionRef.current || !key || !envelopeRef.current) return false
      const payload = { schemaVersion: 2, items: nextEntries, preferences: normalizePreferences(preferences) }
      const nextEnvelope = await persistVault(key, envelopeRef.current, payload)
      if (session !== sessionRef.current) return false
      envelopeRef.current = nextEnvelope
      setEnvelope(nextEnvelope)
      return true
    })
    writeQueueRef.current = operation.catch(() => {})
    return operation
  }

  async function commitEntries(nextEntries) {
    entriesRef.current = nextEntries
    try {
      if (encrypted) {
        const applied = await queueEncryptedSnapshot(nextEntries)
        if (!applied) throw new Error('The vault locked before the change could finish.')
      }
      committedEntriesRef.current = nextEntries
      setEntries(nextEntries)
    } catch (error) {
      if (entriesRef.current === nextEntries) {
        entriesRef.current = committedEntriesRef.current
        setEntries(committedEntriesRef.current)
      }
      throw error
    }
  }

  async function changeAutoLockMinutes(minutes) {
    const previous = autoLockMinutes
    setAutoLockMinutes(minutes)
    if (!encrypted) return
    try {
      const applied = await queueEncryptedSnapshot(entriesRef.current, currentPreferences({ autoLockMinutes: minutes }))
      if (!applied) return
      showToast('Auto-lock preference encrypted & saved')
    } catch (error) {
      setAutoLockMinutes(previous)
      showToast(mutationErrorMessage(error, 'Could not save that preference'), 'error')
    }
  }

  async function changeClipboardClearSeconds(seconds) {
    const previous = clipboardClearSeconds
    setClipboardClearSeconds(seconds)
    if (!encrypted) return
    try {
      const applied = await queueEncryptedSnapshot(entriesRef.current, currentPreferences({ clipboardClearSeconds: seconds }))
      if (!applied) return
      showToast('Clipboard timer encrypted & saved')
    } catch (error) {
      setClipboardClearSeconds(previous)
      showToast(mutationErrorMessage(error, 'Could not save that preference'), 'error')
    }
  }

  async function changePasswordHistoryLimit(limit) {
    const previous = passwordHistoryLimit
    const previousEntries = entriesRef.current
    const nextEntries = previousEntries.map((entry) => ({ ...entry, passwordHistory: (entry.passwordHistory || []).slice(0, limit) }))
    setPasswordHistoryLimit(limit)
    entriesRef.current = nextEntries
    if (!encrypted) {
      setEntries(nextEntries)
      committedEntriesRef.current = nextEntries
      return
    }
    try {
      const applied = await queueEncryptedSnapshot(nextEntries, currentPreferences({ passwordHistoryLimit: limit }))
      if (!applied) return
      committedEntriesRef.current = nextEntries
      setEntries(nextEntries)
      showToast('Password-history retention encrypted & saved')
    } catch (error) {
      entriesRef.current = previousEntries
      setPasswordHistoryLimit(previous)
      showToast(mutationErrorMessage(error, 'Could not save that preference'), 'error')
    }
  }

  function openEditor(entry = null) {
    setEditorEntry(entry || undefined)
    setEditorOpen(true)
  }

  async function saveEntry(form) {
    const now = new Date().toISOString()
    const currentEntries = entriesRef.current
    const previous = form.id ? currentEntries.find((entry) => entry.id === form.id) : null
    const passwordChangedAt = !previous || previous.password !== form.password
      ? now
      : previous.passwordChangedAt || previous.updatedAt || previous.createdAt || now
    const passwordHistory = previous && previous.password !== form.password && passwordHistoryLimit > 0
      ? [{ password: previous.password, changedAt: now }, ...(previous.passwordHistory || [])].slice(0, passwordHistoryLimit)
      : (previous?.passwordHistory || form.passwordHistory || []).slice(0, passwordHistoryLimit)
    const item = form.id
      ? { ...form, revision: (previous?.revision || 1) + 1, encryptionVersion: 2, passwordHistory, passwordChangedAt, updatedAt: now }
      : { ...form, id: crypto.randomUUID(), revision: 1, encryptionVersion: 2, passwordHistory: [], tags: form.tags || [], createdAt: now, passwordChangedAt, updatedAt: now, lastUsed: 'Never' }
    const next = form.id ? currentEntries.map((entry) => entry.id === form.id ? item : entry) : [item, ...currentEntries]
    try {
      await commitEntries(next)
      setSelectedId(item.id)
      setEditorOpen(false)
      showToast(form.id ? 'Changes encrypted & saved' : 'Secret added to your vault')
    } catch (error) {
      showToast(mutationErrorMessage(error, 'Could not save that change'), 'error')
    }
  }

  async function quickUpdate(entry) {
    try {
      const now = new Date().toISOString()
      await commitEntries(entriesRef.current.map((item) => item.id === entry.id ? { ...entry, revision: (item.revision || 1) + 1, encryptionVersion: 2, updatedAt: now } : item))
    } catch (error) {
      showToast(mutationErrorMessage(error, 'Could not save that change'), 'error')
    }
  }

  async function markEntryUsed(id) {
    const now = new Date().toISOString()
    const next = entriesRef.current.map((entry) => entry.id === id ? { ...entry, revision: (entry.revision || 1) + 1, encryptionVersion: 2, updatedAt: now, lastUsed: 'Just now', lastUsedAt: now } : entry)
    try {
      await commitEntries(next)
    } catch (error) {
      showToast(mutationErrorMessage(error, 'Could not update recent activity'), 'error')
    }
  }

  async function clearPasswordHistory(entry) {
    try {
      const now = new Date().toISOString()
      const next = entriesRef.current.map((item) => item.id === entry.id ? { ...item, passwordHistory: [], revision: (item.revision || 1) + 1, updatedAt: now } : item)
      await commitEntries(next)
      showToast('Encrypted password history deleted')
    } catch (error) {
      showToast(mutationErrorMessage(error, 'Could not delete password history'), 'error')
    }
  }

  async function confirmDelete() {
    const target = deleteTarget
    if (!target) return
    try {
      const next = entriesRef.current.filter((entry) => entry.id !== target.id)
      await commitEntries(next)
      setSelectedId(next[0]?.id || '')
      setDeleteTarget(null)
      showToast('Secret removed')
    } catch (error) {
      showToast(mutationErrorMessage(error, 'Could not delete that secret'), 'error')
    }
  }

  async function copyValue(label, value) {
    try {
      await navigator.clipboard.writeText(value)
      copiedValueRef.current = value
      setClipboardState({ id: crypto.randomUUID(), label, remaining: clipboardClearSeconds, deadline: Date.now() + clipboardClearSeconds * 1000 })
      showToast(`${label} copied · clearing in ${clipboardClearSeconds}s`)
    } catch {
      showToast('Clipboard permission was blocked', 'error')
    }
  }

  async function importEntries(items) {
    const nextItems = normalizePasswordDates(items)
    const next = [...nextItems, ...entriesRef.current]
    await commitEntries(next)
    setSelectedId(nextItems[0]?.id || selectedId)
    showToast(`${nextItems.length} secrets imported`)
  }

  async function updateMasterPassword(currentPassword, nextPassword) {
    setBusy(true)
    try {
      await writeQueueRef.current.catch(() => {})
      const changed = await changeMasterPassword(currentPassword, nextPassword, envelopeRef.current)
      sessionRef.current += 1
      dataKeyRef.current = changed.dataKey
      envelopeRef.current = changed.envelope
      setEnvelope(changed.envelope)
      setChangePasswordOpen(false)
      showToast('Master password changed · vault key rewrapped')
    } finally {
      setBusy(false)
    }
  }

  async function recoverWithKey(recoveryKey, nextPassword) {
    setBusy(true)
    try {
      const recovered = await recoverVault(recoveryKey, nextPassword)
      const openedItems = normalizePasswordDates(recovered.payload.items)
      sessionRef.current += 1
      dataKeyRef.current = recovered.dataKey
      envelopeRef.current = recovered.envelope
      entriesRef.current = openedItems
      committedEntriesRef.current = openedItems
      setEnvelope(recovered.envelope)
      setEntries(openedItems)
      applyPreferences(recovered.payload.preferences)
      setSelectedId(openedItems[0]?.id || '')
      setRecoverOpen(false)
      setStatus('unlocked')
      setLockNotice('')
      showToast('Vault recovered · old master password replaced')
    } finally {
      setBusy(false)
    }
  }

  function chooseRestoreFile(file) {
    if (file.size > 50 * 1024 * 1024) {
      showToast('That backup is over the 50 MB restore limit', 'error')
      return
    }
    setRestoreFile(file)
  }

  async function restoreArchive(password) {
    setBusy(true)
    try {
      await writeQueueRef.current.catch(() => {})
      const serialized = await restoreFile.text()
      const incoming = deserializeEnvelope(serialized)
      const opened = await unlockVaultEnvelope(password, incoming)
      await restoreVaultArchive(opened.envelope, { replace: Boolean(await readStoredVault()) })
      const openedItems = normalizePasswordDates(opened.payload.items)
      sessionRef.current += 1
      writeQueueRef.current = Promise.resolve()
      dataKeyRef.current = opened.dataKey
      envelopeRef.current = opened.envelope
      entriesRef.current = openedItems
      committedEntriesRef.current = openedItems
      setEnvelope(opened.envelope)
      setEntries(openedItems)
      applyPreferences(opened.payload.preferences)
      setSelectedId(openedItems[0]?.id || '')
      setRestoreFile(null)
      setOnboardingOpen(false)
      setStatus('unlocked')
      showToast('Encrypted backup authenticated & restored')
    } finally {
      setBusy(false)
    }
  }

  async function exportArchive() {
    if (!encrypted) return
    try {
      const stored = envelope || await readStoredVault()
      const blob = new Blob([serializeEnvelope(stored, 2)], { type: 'application/json' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `hush-backup-${new Date().toISOString().slice(0, 10)}.hush`
      link.click()
      URL.revokeObjectURL(link.href)
      showToast('Encrypted archive downloaded')
    } catch {
      showToast('Could not create the archive', 'error')
    }
  }

  if (status === 'checking') return <div className="app-loading"><span className="brand-seal"><BrandMark /></span><i /></div>
  if (status === 'locked') return <><LockScreen onUnlock={unlock} onRecover={() => setRecoverOpen(true)} onLogout={() => setLogoutOpen(true)} busy={busy} notice={lockNotice} />{recoverOpen && <RecoverVaultDialog onClose={() => setRecoverOpen(false)} onConfirm={recoverWithKey} busy={busy} />}{logoutOpen && <LogoutDialog onClose={() => setLogoutOpen(false)} onConfirm={logoutFromDevice} busy={busy} />}{toast && <div className={`toast ${toast.tone}`} role="status" key={toast.id}>{toast.tone === 'error' ? <AlertTriangle size={16} /> : <Check size={16} />}{toast.message}</div>}</>

  return (
    <div className="app-shell">
      <Sidebar view={view} setView={setView} filter={filter} setFilter={setFilter} entries={entries} encrypted={encrypted} linkState={linkState} onLock={lockVault} collapsed={sidebarCollapsed} setCollapsed={setSidebarCollapsed} />
      <div className="mobile-header"><button className="brand-seal" type="button" onClick={() => setView('vault')} aria-label="Open vault"><BrandMark /></button><strong>hush.</strong><span className={encrypted ? 'encrypted' : 'demo'}>{encrypted ? 'Encrypted' : 'Demo'}</span><button className="icon-button" type="button" onClick={lockVault} aria-label={encrypted ? 'Lock vault' : 'Protect this vault'}><Lock size={18} /></button></div>
      <div className="main-area">
        {view === 'vault' && <VaultView entries={entries} search={search} setSearch={setSearch} filter={filter} setFilter={setFilter} selectedId={selectedId} setSelectedId={setSelectedId} searchRef={searchRef} onAdd={() => openEditor()} onEdit={(entry, quick) => quick ? quickUpdate(entry) : openEditor(entry)} onDelete={setDeleteTarget} onClearHistory={clearPasswordHistory} onCopy={copyValue} onUse={markEntryUsed} clipboardState={clipboardState} encrypted={encrypted} linkState={linkState} onSecurity={() => setView('security')} onHelp={() => showToast('Tip: press Ctrl or ⌘ + K to jump to search')} />}
        {view === 'security' && <SecurityView entries={entries} onBackToVault={(id) => { setSelectedId(id); setFilter('risk'); setView('vault') }} />}
        {view === 'import' && <ImportView entries={entries} onImport={importEntries} onDone={() => { setFilter('all'); setView('vault') }} encrypted={encrypted} />}
        {view === 'settings' && <SettingsView encrypted={encrypted} autoLockMinutes={autoLockMinutes} setAutoLockMinutes={changeAutoLockMinutes} clipboardClearSeconds={clipboardClearSeconds} setClipboardClearSeconds={changeClipboardClearSeconds} passwordHistoryLimit={passwordHistoryLimit} setPasswordHistoryLimit={changePasswordHistoryLimit} onExport={exportArchive} onRestoreFile={chooseRestoreFile} onChangePassword={() => setChangePasswordOpen(true)} onLock={lockVault} onProtect={() => setOnboardingOpen(true)} onLogout={() => setLogoutOpen(true)} deviceLink={{ linkState, peerName, onCreateOffer: () => linkRef.current.createOffer(), onAcceptOffer: (code) => linkRef.current.acceptOffer(code), onAcceptAnswer: (code) => linkRef.current.acceptAnswer(code), onDisconnect: () => linkRef.current?.close() }} installApp={{ installed: appInstalled, canInstall: Boolean(installPrompt), onInstall: installCurrentApp }} />}
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navItems.slice(0, 2).map(({ id, label, icon: Icon }) => <button type="button" aria-current={view === id ? 'page' : undefined} className={view === id ? 'active' : ''} key={id} onClick={() => setView(id)}><Icon size={19} /><span>{label}</span></button>)}
        <button type="button" className="mobile-add" onClick={() => openEditor()} aria-label="Add new password" title="Add new password"><Plus size={22} /></button>
        {navItems.slice(2).map(({ id, label, icon: Icon }) => <button type="button" aria-current={view === id ? 'page' : undefined} className={view === id ? 'active' : ''} key={id} onClick={() => setView(id)}><Icon size={19} /><span>{label}</span></button>)}
      </nav>
      {editorOpen && <EntryEditor entry={editorEntry} onClose={() => setEditorOpen(false)} onSave={saveEntry} onCopy={copyValue} />}
      {deleteTarget && <DeleteDialog entry={deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={confirmDelete} />}
      {logoutOpen && <LogoutDialog onClose={() => setLogoutOpen(false)} onConfirm={logoutFromDevice} busy={busy} />}
      {changePasswordOpen && <ChangePasswordDialog onClose={() => setChangePasswordOpen(false)} onConfirm={updateMasterPassword} busy={busy} />}
      {restoreFile && <RestoreDialog file={restoreFile} replacing={encrypted} onClose={() => setRestoreFile(null)} onConfirm={restoreArchive} busy={busy} />}
      {onboardingOpen && <Onboarding onClose={() => setOnboardingOpen(false)} onCreate={createEncryptedVault} onLink={() => { setOnboardingOpen(false); setView('settings') }} busy={busy} sampleCount={entries.filter((entry) => entry.id.startsWith('sample-')).length} />}
      {recoveryKeyDisplay && <RecoveryKeyDialog recoveryKey={recoveryKeyDisplay} onCopy={copyValue} onClose={() => setRecoveryKeyDisplay('')} />}
      {toast && <div className={`toast ${toast.tone}`} role="status" key={toast.id}>{toast.tone === 'error' ? <AlertTriangle size={16} /> : <Check size={16} />}{toast.message}</div>}
    </div>
  )
}
