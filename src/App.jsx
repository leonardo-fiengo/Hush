import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
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
import {
  createVault,
  applyTransferredVault,
  hasStoredVault,
  installTransferredVault,
  ITERATIONS,
  openVaultEnvelope,
  persistVault,
  readStoredVault,
  unlockVault,
  unlockVaultEnvelope,
} from './lib/vaultCrypto.js'
import { createDeviceLink } from './lib/deviceLink.js'
import { safeHttpUrl } from './lib/importer.js'
import {
  countPasswords,
  masterPasswordHealth,
  passwordHealth,
  passwordRisk,
  vaultHealthScore,
} from './lib/passwordRisk.js'
import {
  compareEnvelopeVersions,
  sameVault,
  serializeEnvelope,
} from './lib/vaultTransfer.js'

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
  return items.map((entry) => entry.passwordChangedAt || (!entry.updatedAt && !entry.createdAt)
    ? entry
    : { ...entry, passwordChangedAt: entry.updatedAt || entry.createdAt })
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

function securePassword(length = 20) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*-_+'
  const unbiasedLimit = 256 - (256 % alphabet.length)
  let result = ''
  while (result.length < length) {
    const values = crypto.getRandomValues(new Uint8Array(Math.max(16, length - result.length)))
    values.forEach((value) => {
      if (value < unbiasedLimit && result.length < length) result += alphabet[value % alphabet.length]
    })
  }
  return result
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

function DetailPanel({ entry, passwordCounts, onCopy, clipboardState, onEdit, onDelete, mobileOpen, onMobileClose }) {
  const [revealed, setRevealed] = useState(false)
  useEffect(() => setRevealed(false), [entry?.id])

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
        {risk.atRisk && <div className={`password-risk-note ${risk.tone}`}><AlertTriangle size={15} /><span>{risk.reason}</span></div>}
      </div>
      {entry.notes && <div className="field-block notes-field"><label>Private note</label><p>{entry.notes}</p></div>}
      <div className="tag-row">{(entry.tags || []).map((tag) => <span key={tag}>#{tag}</span>)}<span>{entry.collection || 'Unsorted'}</span></div>
      <div className="detail-footer"><div><span>Password changed</span><strong>{passwordChangedAt ? formatUpdated(passwordChangedAt) : 'Unknown'}</strong></div><div><span>Created</span><strong>{new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric' }).format(new Date(entry.createdAt))}</strong></div><button type="button" onClick={() => onDelete(entry)}><Trash2 size={15} /> Delete</button></div>
    </aside>
  )
}

function VaultView({ entries, search, setSearch, filter, setFilter, selectedId, setSelectedId, searchRef, onAdd, onEdit, onDelete, onCopy, onUse, clipboardState, encrypted, linkState, onSecurity, onHelp }) {
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
        <DetailPanel key={selected?.id || 'empty'} entry={selected} passwordCounts={passwordCounts} onCopy={onCopy} clipboardState={clipboardState} onEdit={onEdit} onDelete={onDelete} mobileOpen={mobileDetailOpen} onMobileClose={() => setMobileDetailOpen(false)} />
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
          <p>A random AES-256-GCM key protects the complete vault—including names, URLs, and notes. Your master password wraps that key using {ITERATIONS.toLocaleString()} PBKDF2 iterations and is never stored.</p>
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

function DeviceSyncCard({ encrypted, linkState, peerName, onCreateOffer, onAcceptOffer, onAcceptAnswer, onDisconnect }) {
  const [mode, setMode] = useState('idle')
  const [offerCode, setOfferCode] = useState('')
  const [answerCode, setAnswerCode] = useState('')
  const [remoteCode, setRemoteCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
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

  async function createAnswerCode() {
    setBusy(true)
    setError('')
    try {
      setAnswerCode(await onAcceptOffer(remoteCode))
    } catch (answerError) {
      setError(answerError.message || 'Could not read that pairing code.')
    } finally {
      setBusy(false)
    }
  }

  async function finishPairing() {
    setBusy(true)
    setError('')
    try {
      await onAcceptAnswer(remoteCode)
    } catch (answerError) {
      setError(answerError.message || 'Could not open the device link.')
    } finally {
      setBusy(false)
    }
  }

  function reset() {
    onDisconnect()
    setMode('idle')
    setOfferCode('')
    setAnswerCode('')
    setRemoteCode('')
    setError('')
  }

  return (
    <section className="settings-card wide device-sync-card">
      <div className="settings-card-title">
        <span><Link2 size={20} /></span>
        <div><h2>Phone + laptop</h2><p>Pair two open Hush apps and move the encrypted vault directly between them.</p></div>
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
          <div><h3>Bring Hush to your phone.</h3><p>Open the same HTTPS Hush address on your phone, install it, then use two one-time codes to make a direct link. No Hush account is needed.</p></div>
          <div><button type="button" className="primary-button" onClick={() => { setMode('offer'); void createOfferCode() }}><Laptop size={16} /> Create a code</button><button type="button" className="secondary-button" onClick={() => setMode('join')}><Smartphone size={16} /> Use a code</button></div>
        </div>
      ) : (
        <div className="pairing-workspace">
          <div className="pairing-steps">
            <button type="button" onClick={reset}>Back</button>
            <p className="eyebrow">{mode === 'offer' ? 'Device 1 · start here' : 'Device 2 · answer here'}</p>
            <h3>{mode === 'offer' ? 'Send an offer, then paste the reply.' : 'Paste the offer and send back the reply.'}</h3>
            <p>Pairing codes contain connection details, never your master password or decrypted secrets.</p>
          </div>
          {mode === 'offer' ? (
            <div className="pairing-fields">
              <label><span>1. Offer code</span><textarea readOnly value={offerCode} placeholder={busy ? 'Creating a one-time code…' : 'Create a fresh pairing code'} rows="3" /></label>
              <button type="button" className="code-copy" onClick={() => copyCode(offerCode)} disabled={!offerCode}><Share2 size={14} /> Copy offer</button>
              <label><span>2. Response from the other device</span><textarea value={remoteCode} onChange={(event) => setRemoteCode(event.target.value)} placeholder="Paste the HUSH1 response code" rows="3" /></label>
              <button type="button" className="primary-button" onClick={finishPairing} disabled={!remoteCode.trim() || busy}>{busy ? 'Connecting…' : 'Finish linking'} <ArrowRight size={15} /></button>
            </div>
          ) : (
            <div className="pairing-fields">
              <label><span>1. Offer from the first device</span><textarea value={remoteCode} onChange={(event) => setRemoteCode(event.target.value)} placeholder="Paste the HUSH1 offer code" rows="3" /></label>
              {!answerCode && <button type="button" className="primary-button" onClick={createAnswerCode} disabled={!remoteCode.trim() || busy}>{busy ? 'Preparing…' : 'Create response'} <ArrowRight size={15} /></button>}
              {answerCode && <><label><span>2. Response code</span><textarea readOnly value={answerCode} rows="3" /></label><button type="button" className="code-copy" onClick={() => copyCode(answerCode)}><Share2 size={14} /> Copy response</button><p className="waiting-note"><span className="live-pip" /> Waiting for the first device to finish linking…</p></>}
            </div>
          )}
        </div>
      )}
      {(error || linkState.state === 'error') && <p className="inline-error device-error"><AlertTriangle size={15} /> {error || linkState.detail}</p>}
      <div className="device-privacy"><Shield size={15} /><span>{encrypted ? 'Only ciphertext crosses the link. The other device unlocks with your existing master password.' : 'This device can receive an encrypted vault. Demo items are never sent as a real vault.'}</span></div>
    </section>
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

function SettingsView({ encrypted, autoLockMinutes, setAutoLockMinutes, onExport, onLock, onProtect, deviceLink, installApp }) {
  return (
    <main className="settings-view page-enter">
      <header className="page-heading"><div><p className="eyebrow"><Settings size={14} /> Vault preferences</p><h1>Fewer switches.<br /><em>Better defaults.</em></h1><p className="heading-copy">Security choices should be understandable, not a maze of fine print.</p></div></header>
      <div className="settings-layout">
        <DeviceSyncCard encrypted={encrypted} {...deviceLink} />
        <InstallAppCard {...installApp} />
        <section className="settings-card"><div className="settings-card-title"><span><Clock3 size={20} /></span><div><h2>Automatic lock</h2><p>Drop the decrypted key after a period of inactivity.</p></div></div><label className="setting-row"><span><strong>Lock after</strong><small>Mouse and keyboard activity reset the timer.</small></span><select value={autoLockMinutes} onChange={(event) => setAutoLockMinutes(Number(event.target.value))}><option value={5}>5 minutes</option><option value={10}>10 minutes</option><option value={30}>30 minutes</option><option value={60}>1 hour</option></select></label><button className="settings-action" type="button" onClick={encrypted ? onLock : onProtect}><Lock size={16} /> {encrypted ? 'Lock right now' : 'Create a protected vault'}<ArrowRight size={16} /></button></section>
        <section className="settings-card"><div className="settings-card-title"><span><Copy size={20} /></span><div><h2>Clipboard care</h2><p>Copied passwords show a 30-second timer in the app.</p></div></div><div className="honest-note"><Info size={16} /><p>Hush attempts to clear a copied password only if the browser allows it and your clipboard still contains that same value. Clipboard clearing is best-effort.</p></div></section>
        <section className="settings-card wide"><div className="settings-card-title"><span><Database size={20} /></span><div><h2>Encrypted archive</h2><p>Download the encrypted vault envelope—never a plaintext password list.</p></div></div><div className="backup-row"><div><span className={`backup-badge ${encrypted ? 'ready' : ''}`}><HardDrive size={17} /> {encrypted ? 'Encrypted archive ready' : 'Demo vault has no archive'}</span><small>{encrypted ? 'Includes ciphertext, salt, IVs, and version metadata. Archive restore is not included yet.' : 'Protect the demo first to create an exportable envelope.'}</small></div><button type="button" className="secondary-button" onClick={onExport} disabled={!encrypted}><Download size={16} /> Download .hush</button></div></section>
        <section className="settings-card wide technical"><p className="eyebrow">Technical note</p><h2>Built on browser-native cryptography.</h2><div><span><strong>AES-256-GCM</strong><small>Authenticated vault encryption</small></span><span><strong>PBKDF2 · SHA-256</strong><small>{ITERATIONS.toLocaleString()} derivation rounds</small></span><span><strong>IndexedDB</strong><small>Encrypted envelope at rest</small></span><span><strong>Local only</strong><small>No analytics or remote scripts</small></span></div></section>
      </div>
    </main>
  )
}

function EntryEditor({ entry, onClose, onSave }) {
  const savingRef = useRef(false)
  const closeIfIdle = () => { if (!savingRef.current) onClose() }
  const dialogRef = useDialogFocus(closeIfIdle)
  const [form, setForm] = useState(() => ({ ...emptyEntry, ...(entry || {}) }))
  const [showPassword, setShowPassword] = useState(false)
  const [length, setLength] = useState(20)
  const [saving, setSaving] = useState(false)
  const isEdit = Boolean(entry?.id)
  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }))

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
          <div className="password-editor">
            <label className="input-field"><span>Password <b>Required</b></span><div><input type={showPassword ? 'text' : 'password'} value={form.password} onChange={(event) => update('password', event.target.value)} placeholder="Add or generate a password" autoComplete="new-password" required /><button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
            <div className="generator-line"><WandSparkles size={16} /><label><span>Length</span><input type="range" min="14" max="32" value={length} onChange={(event) => setLength(Number(event.target.value))} /><b>{length}</b></label><button type="button" onClick={() => update('password', securePassword(length))}>Generate</button></div>
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
            <p>There is no password recovery. A memorable passphrase is safer than something short and clever.</p>
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

function LockScreen({ onUnlock, busy, notice }) {
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
      </form>
      <div className="lock-footer"><span>NO RECOVERY · BY DESIGN</span><span>AES-256-GCM</span><span>LOCAL VAULT / 01</span></div>
    </main>
  )
}

export default function App() {
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
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState(null)
  const [clipboardState, setClipboardState] = useState(null)
  const [autoLockMinutes, setAutoLockMinutes] = useState(10)
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

  const encrypted = status === 'unlocked'
  statusRef.current = status

  useEffect(() => {
    let active = true
    hasStoredVault().then((exists) => {
      if (!active) return
      if (exists) {
        setStatus('locked')
      } else {
        const demoEntries = normalizePasswordDates(sampleEntries)
        entriesRef.current = demoEntries
        committedEntriesRef.current = demoEntries
        setEntries(demoEntries)
        setStatus('demo')
        setOnboardingOpen(true)
      }
    }).catch(() => {
      if (!active) return
      const demoEntries = normalizePasswordDates(sampleEntries)
      entriesRef.current = demoEntries
      committedEntriesRef.current = demoEntries
      setEntries(demoEntries)
      setStatus('demo')
      setOnboardingOpen(true)
    })
    return () => { active = false }
  }, [])

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
    if (status !== 'unlocked') return undefined
    let timer
    const reset = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => lockVault(), autoLockMinutes * 60_000)
    }
    const events = ['pointerdown', 'keydown']
    events.forEach((event) => window.addEventListener(event, reset, { passive: true }))
    reset()
    return () => {
      window.clearTimeout(timer)
      events.forEach((event) => window.removeEventListener(event, reset))
    }
  }, [status, autoLockMinutes])

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
      setAutoLockMinutes(payload.preferences?.autoLockMinutes || 10)
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
      const payload = { schemaVersion: 1, items: nextItems, preferences: { autoLockMinutes } }
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
        await installTransferredVault(waiting)
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
      setAutoLockMinutes(nextPayload.preferences?.autoLockMinutes || 10)
      setSelectedId(openedItems[0]?.id || '')
      setStatus('unlocked')
      setLockNotice('')
    } finally {
      setBusy(false)
    }
  }

  function lockVault() {
    if (status === 'demo') {
      setOnboardingOpen(true)
      return
    }
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

  async function queueEncryptedSnapshot(nextEntries, nextAutoLockMinutes) {
    const session = sessionRef.current
    const key = dataKeyRef.current
    const operation = writeQueueRef.current.catch(() => {}).then(async () => {
      if (session !== sessionRef.current || !key || !envelopeRef.current) return false
      const payload = { schemaVersion: 1, items: nextEntries, preferences: { autoLockMinutes: nextAutoLockMinutes } }
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
        const applied = await queueEncryptedSnapshot(nextEntries, autoLockMinutes)
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
      const applied = await queueEncryptedSnapshot(entriesRef.current, minutes)
      if (!applied) return
      showToast('Auto-lock preference encrypted & saved')
    } catch (error) {
      setAutoLockMinutes(previous)
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
    const item = form.id
      ? { ...form, passwordChangedAt, updatedAt: now }
      : { ...form, id: crypto.randomUUID(), tags: form.tags || [], createdAt: now, passwordChangedAt, updatedAt: now, lastUsed: 'Never' }
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
      await commitEntries(entriesRef.current.map((item) => item.id === entry.id ? entry : item))
    } catch (error) {
      showToast(mutationErrorMessage(error, 'Could not save that change'), 'error')
    }
  }

  async function markEntryUsed(id) {
    const now = new Date().toISOString()
    const next = entriesRef.current.map((entry) => entry.id === id ? { ...entry, lastUsed: 'Just now', lastUsedAt: now } : entry)
    try {
      await commitEntries(next)
    } catch (error) {
      showToast(mutationErrorMessage(error, 'Could not update recent activity'), 'error')
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
      setClipboardState({ id: crypto.randomUUID(), label, remaining: 30, deadline: Date.now() + 30_000 })
      showToast(`${label} copied · clearing in 30s`)
    } catch {
      showToast('Clipboard permission was blocked', 'error')
    }
  }

  async function importEntries(items) {
    const next = [...items, ...entriesRef.current]
    await commitEntries(next)
    setSelectedId(items[0]?.id || selectedId)
    showToast(`${items.length} secrets imported`)
  }

  async function exportArchive() {
    if (!encrypted) return
    try {
      const stored = envelope || await readStoredVault()
      const blob = new Blob([serializeEnvelope(stored, 2)], { type: 'application/json' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `hush-vault-${new Date().toISOString().slice(0, 10)}.hush`
      link.click()
      URL.revokeObjectURL(link.href)
      showToast('Encrypted archive downloaded')
    } catch {
      showToast('Could not create the archive', 'error')
    }
  }

  if (status === 'checking') return <div className="app-loading"><span className="brand-seal"><BrandMark /></span><i /></div>
  if (status === 'locked') return <LockScreen onUnlock={unlock} busy={busy} notice={lockNotice} />

  return (
    <div className="app-shell">
      <Sidebar view={view} setView={setView} filter={filter} setFilter={setFilter} entries={entries} encrypted={encrypted} linkState={linkState} onLock={lockVault} collapsed={sidebarCollapsed} setCollapsed={setSidebarCollapsed} />
      <div className="mobile-header"><button className="brand-seal" type="button" onClick={() => setView('vault')} aria-label="Open vault"><BrandMark /></button><strong>hush.</strong><span className={encrypted ? 'encrypted' : 'demo'}>{encrypted ? 'Encrypted' : 'Demo'}</span><button className="icon-button" type="button" onClick={lockVault} aria-label={encrypted ? 'Lock vault' : 'Protect this vault'}><Lock size={18} /></button></div>
      <div className="main-area">
        {view === 'vault' && <VaultView entries={entries} search={search} setSearch={setSearch} filter={filter} setFilter={setFilter} selectedId={selectedId} setSelectedId={setSelectedId} searchRef={searchRef} onAdd={() => openEditor()} onEdit={(entry, quick) => quick ? quickUpdate(entry) : openEditor(entry)} onDelete={setDeleteTarget} onCopy={copyValue} onUse={markEntryUsed} clipboardState={clipboardState} encrypted={encrypted} linkState={linkState} onSecurity={() => setView('security')} onHelp={() => showToast('Tip: press Ctrl or ⌘ + K to jump to search')} />}
        {view === 'security' && <SecurityView entries={entries} onBackToVault={(id) => { setSelectedId(id); setFilter('risk'); setView('vault') }} />}
        {view === 'import' && <ImportView entries={entries} onImport={importEntries} onDone={() => { setFilter('all'); setView('vault') }} encrypted={encrypted} />}
        {view === 'settings' && <SettingsView encrypted={encrypted} autoLockMinutes={autoLockMinutes} setAutoLockMinutes={changeAutoLockMinutes} onExport={exportArchive} onLock={lockVault} onProtect={() => setOnboardingOpen(true)} deviceLink={{ linkState, peerName, onCreateOffer: () => linkRef.current.createOffer(), onAcceptOffer: (code) => linkRef.current.acceptOffer(code), onAcceptAnswer: (code) => linkRef.current.acceptAnswer(code), onDisconnect: () => linkRef.current?.close() }} installApp={{ installed: appInstalled, canInstall: Boolean(installPrompt), onInstall: installCurrentApp }} />}
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navItems.slice(0, 3).map(({ id, label, icon: Icon }) => <button type="button" aria-current={view === id ? 'page' : undefined} className={view === id ? 'active' : ''} key={id} onClick={() => setView(id)}><Icon size={19} /><span>{label}</span></button>)}
        <button type="button" className="mobile-add" onClick={() => openEditor()} aria-label="Add secret"><Plus size={22} /></button>
        <button type="button" aria-current={view === 'settings' ? 'page' : undefined} className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}><Settings size={19} /><span>Settings</span></button>
      </nav>
      {editorOpen && <EntryEditor entry={editorEntry} onClose={() => setEditorOpen(false)} onSave={saveEntry} />}
      {deleteTarget && <DeleteDialog entry={deleteTarget} onClose={() => setDeleteTarget(null)} onConfirm={confirmDelete} />}
      {onboardingOpen && <Onboarding onClose={() => setOnboardingOpen(false)} onCreate={createEncryptedVault} onLink={() => { setOnboardingOpen(false); setView('settings') }} busy={busy} sampleCount={entries.filter((entry) => entry.id.startsWith('sample-')).length} />}
      {toast && <div className={`toast ${toast.tone}`} role="status" key={toast.id}>{toast.tone === 'error' ? <AlertTriangle size={16} /> : <Check size={16} />}{toast.message}</div>}
    </div>
  )
}
