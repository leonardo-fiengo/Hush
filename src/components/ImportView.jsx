import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  FileKey2,
  FileSpreadsheet,
  Info,
  LockKeyhole,
  RotateCcw,
  Sparkles,
  UploadCloud,
  X,
} from 'lucide-react'
import {
  columnLabel,
  mapImportRows,
  parseDelimitedText,
  parseRowRanges,
  safeHttpUrl,
  suggestMappings,
} from '../lib/importer.js'
import { importSampleCsv } from '../data/sampleVault.js'

const fields = [
  { key: 'name', label: 'Name', hint: 'The service or account name', required: true },
  { key: 'username', label: 'Username', hint: 'Email or sign-in ID' },
  { key: 'password', label: 'Password', hint: 'Kept exactly as written', required: true },
  { key: 'url', label: 'Website', hint: 'A web address' },
  { key: 'notes', label: 'Notes', hint: 'Extra context, including line breaks' },
  { key: 'collection', label: 'Collection', hint: 'Folder or group' },
]

const stepNames = ['Source', 'Map fields', 'Choose rows', 'Review']

function displayDelimiter(value) {
  if (value === '\t') return 'Tab'
  if (value === ';') return 'Semicolon'
  return 'Comma'
}

function duplicateKeys(item) {
  let host = ''
  try {
    const safe = safeHttpUrl(item.url)
    host = safe ? new URL(safe).hostname.replace(/^www\./, '') : ''
  } catch {
    host = ''
  }
  const user = String(item.username || '').trim().toLowerCase()
  const name = String(item.name || '').trim().toLowerCase()
  return [host && `host:${host}|${user}`, name && `name:${name}|${user}`].filter(Boolean)
}

export default function ImportView({ entries, onImport, onDone, encrypted }) {
  const fileInputRef = useRef(null)
  const stageHeadingRef = useRef(null)
  const [step, setStep] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [rawText, setRawText] = useState('')
  const [fileName, setFileName] = useState('')
  const [fileBytes, setFileBytes] = useState(0)
  const [parseError, setParseError] = useState('')
  const [parsed, setParsed] = useState(null)
  const [delimiter, setDelimiter] = useState('auto')
  const [hasHeader, setHasHeader] = useState(true)
  const [mapping, setMapping] = useState({})
  const [rowMode, setRowMode] = useState('all')
  const [rangeExpression, setRangeExpression] = useState('')
  const [duplicatePolicy, setDuplicatePolicy] = useState('keep')
  const [importResult, setImportResult] = useState(null)
  const [commitError, setCommitError] = useState('')
  const [busy, setBusy] = useState(false)

  const headers = useMemo(() => {
    if (!parsed) return []
    if (hasHeader) return parsed.rows[0]
    return Array.from({ length: parsed.columnCount }, (_, index) => `Column ${columnLabel(index)}`)
  }, [parsed, hasHeader])

  const dataRows = useMemo(() => {
    if (!parsed) return []
    return hasHeader ? parsed.rows.slice(1) : parsed.rows
  }, [parsed, hasHeader])

  const rangeResult = useMemo(() => {
    if (!dataRows.length) return { indices: [], error: '' }
    if (rowMode === 'all') return { indices: dataRows.map((_, index) => index), error: '' }
    if (rowMode === 'first') return { indices: dataRows.slice(0, 10).map((_, index) => index), error: '' }
    return parseRowRanges(rangeExpression, dataRows.length)
  }, [dataRows, rowMode, rangeExpression])

  const mappedRows = useMemo(
    () => mapImportRows(dataRows, mapping, rangeResult.indices),
    [dataRows, mapping, rangeResult.indices],
  )

  const existingKeys = useMemo(() => new Set(entries.flatMap(duplicateKeys)), [entries])
  const reviewedRows = useMemo(() => {
    const seen = new Set(existingKeys)
    return mappedRows.map((row) => {
      const keys = duplicateKeys(row)
      const duplicate = keys.some((key) => seen.has(key))
      if (row.valid) keys.forEach((key) => seen.add(key))
      return { ...row, duplicate }
    })
  }, [mappedRows, existingKeys])

  const validRows = reviewedRows.filter((row) => row.valid && !(row.duplicate && duplicatePolicy === 'skip'))
  const invalidCount = reviewedRows.filter((row) => !row.valid).length
  const duplicateCount = reviewedRows.filter((row) => row.duplicate).length
  const mappingComplete = Boolean(mapping.name && mapping.password && mapping.name !== mapping.password)

  useEffect(() => {
    requestAnimationFrame(() => stageHeadingRef.current?.focus())
  }, [step])

  function validateParsed(result, headerRow = true) {
    const dataRowCount = Math.max(0, result.rows.length - (headerRow ? 1 : 0))
    if (dataRowCount > 20_000) throw new Error('This file has more than 20,000 data rows. Split it into smaller exports first.')
    if (result.columnCount > 200) throw new Error('This file has more than 200 columns. Remove unused columns and try again.')
    if (result.rows.some((row) => row.some((cell) => cell.length > 65_536))) throw new Error('At least one cell is over 64 KB. Shorten that value and try again.')
  }

  function configureParsed(result, name, bytes, source, isSample = false) {
    validateParsed(result)
    const nextHeaders = result.rows[0] || []
    setParsed(result)
    setRawText(source)
    setFileName(name)
    setFileBytes(bytes)
    setDelimiter(result.delimiter)
    setHasHeader(true)
    setMapping(suggestMappings(nextHeaders))
    setParseError('')
    if (isSample) {
      setRowMode('custom')
      setRangeExpression('1-10, 14-17, 19-29')
    } else {
      setRowMode('all')
      setRangeExpression(`1-${Math.max(1, result.rows.length - 1)}`)
    }
    setStep(1)
  }

  function parseSource(source, name, bytes, selectedDelimiter = 'auto', isSample = false) {
    try {
      const result = parseDelimitedText(source, selectedDelimiter)
      configureParsed(result, name, bytes, source, isSample)
    } catch (error) {
      setParseError(error.message || 'We could not read that file.')
    }
  }

  async function readFile(file) {
    if (!file) return
    if (file.size > 10 * 1024 * 1024) {
      setParseError('That file is over 10 MB. Split it into smaller exports first.')
      return
    }
    if (!/\.(csv|tsv|txt)$/i.test(file.name)) {
      setParseError('Choose a CSV or TSV file.')
      return
    }
    setParseError('')
    try {
      const source = await file.text()
      parseSource(source, file.name, file.size)
    } catch (error) {
      setParseError(error.message || 'The browser could not read that file. Try exporting it again.')
    }
  }

  function updateDelimiter(value) {
    if (!rawText) return
    try {
      const result = parseDelimitedText(rawText, value)
      validateParsed(result, hasHeader)
      setDelimiter(value)
      setParsed(result)
      setMapping(suggestMappings(hasHeader ? result.rows[0] : []))
      setParseError('')
    } catch (error) {
      setParseError(error.message || 'That delimiter does not match this file.')
    }
  }

  function updateHeader(value) {
    try {
      validateParsed(parsed, value)
    } catch (error) {
      setParseError(error.message)
      return
    }
    setParseError('')
    setHasHeader(value)
    const nextHeaders = value ? (parsed?.rows[0] || []) : []
    setMapping(value ? suggestMappings(nextHeaders) : {})
    const nextLength = value ? Math.max(0, (parsed?.rows.length || 0) - 1) : parsed?.rows.length || 0
    setRangeExpression(`1-${Math.max(1, nextLength)}`)
  }

  function resetImport() {
    setStep(0)
    setParsed(null)
    setRawText('')
    setFileName('')
    setFileBytes(0)
    setParseError('')
    setMapping({})
    setImportResult(null)
    setCommitError('')
  }

  async function commitImport() {
    if (!validRows.length) return
    setBusy(true)
    setCommitError('')
    const now = new Date().toISOString()
    const batchId = crypto.randomUUID()
    const items = validRows.map((row) => ({
      id: crypto.randomUUID(),
      name: row.name,
      username: row.username,
      password: row.password,
      url: safeHttpUrl(row.url) || row.url,
      notes: row.notes,
      collection: row.collection,
      tags: ['imported'],
      favorite: false,
      createdAt: now,
      passwordChangedAt: now,
      updatedAt: now,
      lastUsed: 'Never',
      importBatch: batchId,
    }))
    try {
      await onImport(items)
      setImportResult({ imported: items.length, skipped: reviewedRows.length - items.length, batchId })
      setRawText('')
      setParsed(null)
      setStep(4)
    } catch (error) {
      setCommitError(error.message || 'The import could not be saved. No rows were added.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="import-view page-enter" aria-labelledby="import-title">
      <header className="page-heading import-heading">
        <div>
          <p className="eyebrow"><FileKey2 size={14} /> Local import studio</p>
          <h1 id="import-title">Bring the useful parts.<br /><em>Leave the mess.</em></h1>
          <p className="heading-copy">Map any spreadsheet your way, choose exact rows, then encrypt the result in one move.</p>
        </div>
        <div className="local-only-note">
          <LockKeyhole size={18} />
          <div><strong>Stays on this device</strong><span>Your source file is read locally and never uploaded.</span></div>
        </div>
      </header>

      {step < 4 && (
        <nav className="stepper" aria-label="Import progress">
          {stepNames.map((name, index) => (
            <button
              type="button"
              key={name}
              className={`step ${index === step ? 'active' : ''} ${index < step ? 'complete' : ''}`}
              disabled={index > step}
              onClick={() => index < step && setStep(index)}
              aria-current={index === step ? 'step' : undefined}
              aria-label={name}
            >
              <span>{index < step ? <Check size={15} /> : String(index + 1).padStart(2, '0')}</span>
              {name}
            </button>
          ))}
        </nav>
      )}

      <section className="import-stage">
        {step === 0 && (
          <div className="source-stage stage-enter">
            <h2 className="visually-hidden">Choose a CSV or TSV source file</h2>
            <button
              ref={stageHeadingRef}
              className={`drop-zone ${dragging ? 'dragging' : ''}`}
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                readFile(event.dataTransfer.files[0])
              }}
            >
              <span className="drop-icon"><UploadCloud size={28} /></span>
              <strong>{dragging ? 'Drop it right here' : 'Drop a password export'}</strong>
              <span>CSV or TSV, up to 10 MB</span>
              <small>or click to choose a file</small>
            </button>
            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              tabIndex="-1"
              accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
              onChange={(event) => readFile(event.target.files?.[0])}
            />
            <div className="sample-import">
              <div>
                <Sparkles size={17} />
                <span><strong>No export handy?</strong> Try a safe 35-row sample and test the range tool.</span>
              </div>
              <button
                className="text-button"
                type="button"
                onClick={() => parseSource(importSampleCsv, 'hush-sample.csv', new Blob([importSampleCsv]).size, 'auto', true)}
              >
                Load sample <ArrowRight size={15} />
              </button>
            </div>
            {parseError && <p className="inline-error" role="alert"><AlertCircle size={16} /> {parseError}</p>}
          </div>
        )}

        {step === 1 && parsed && (
          <div className="map-stage stage-enter">
            <div className="import-toolbar">
              <div className="file-chip"><FileSpreadsheet size={18} /><div><strong>{fileName}</strong><span>{dataRows.length} data rows · {parsed.columnCount} columns · {(fileBytes / 1024).toFixed(1)} KB</span></div><button type="button" onClick={resetImport} aria-label="Remove file"><X size={16} /></button></div>
              <div className="source-controls">
                <label>Delimiter<select value={delimiter} onChange={(event) => updateDelimiter(event.target.value)}><option value="auto">Auto ({displayDelimiter(parsed.delimiter)})</option><option value=",">Comma</option><option value=";">Semicolon</option><option value={'\t'}>Tab</option></select><ChevronDown size={14} /></label>
                <label className="switch-line"><input type="checkbox" checked={hasHeader} onChange={(event) => updateHeader(event.target.checked)} /><span className="switch" /> First row is headings</label>
              </div>
            </div>
            {parseError && <p className="inline-error" role="alert"><AlertCircle size={16} /> {parseError}</p>}

            <div className="mapping-layout">
              <div className="mapping-fields">
                <div className="section-label"><span>01</span><div><h2 ref={stageHeadingRef} tabIndex="-1">Connect your columns</h2><small>Name and password are required.</small></div></div>
                {fields.map((field) => {
                  const usedValues = Object.entries(mapping).filter(([key]) => key !== field.key).map(([, value]) => value)
                  return (
                    <label className={`mapping-card ${mapping[field.key] !== undefined ? 'mapped' : ''}`} key={field.key}>
                      <div><span>{field.label}{field.required && <b>Required</b>}</span><small>{field.hint}</small></div>
                      <div className="select-shell">
                        <select
                          value={mapping[field.key] ?? ''}
                          onChange={(event) => setMapping((current) => ({ ...current, [field.key]: event.target.value || undefined }))}
                        >
                          <option value="">Ignore</option>
                          {headers.map((header, index) => (
                            <option key={`${columnLabel(index)}-${header}`} value={String(index)} disabled={usedValues.includes(String(index))}>
                              {columnLabel(index)} — {header || 'Untitled column'}
                            </option>
                          ))}
                        </select>
                        <ChevronDown size={15} />
                      </div>
                    </label>
                  )
                })}
              </div>

              <div className="preview-card">
                <div className="preview-title"><div><span>Live preview</span><small>Passwords stay masked</small></div><span className="status-dot">Parsed locally</span></div>
                <div className="table-scroll">
                  <table>
                    <thead><tr><th>#</th>{headers.map((header, index) => <th className={Object.values(mapping).includes(String(index)) ? 'mapped-column' : ''} key={`${header}-${index}`}><span>{columnLabel(index)}</span>{header || `Column ${columnLabel(index)}`}</th>)}</tr></thead>
                    <tbody>{dataRows.slice(0, 8).map((row, rowIndex) => <tr key={rowIndex}><td>{rowIndex + 1}</td>{row.map((cell, columnIndex) => <td className={Object.values(mapping).includes(String(columnIndex)) ? 'mapped-column' : ''} key={columnIndex}>{mapping.password === String(columnIndex) ? '••••••••••' : cell || <i>empty</i>}</td>)}</tr>)}</tbody>
                  </table>
                </div>
                {dataRows.length > 8 && <div className="table-fade">+ {dataRows.length - 8} more rows</div>}
              </div>
            </div>
            {!mappingComplete && <p className="mapping-hint"><Info size={15} /> Map both a name and password column to continue.</p>}
          </div>
        )}

        {step === 2 && parsed && (
          <div className="rows-stage stage-enter">
            <div className="range-panel">
              <div className="section-label"><span>02</span><div><h2 ref={stageHeadingRef} tabIndex="-1">Choose exactly what comes in</h2><small>Row 1 means the first data record {hasHeader ? 'after your headings' : 'in the file'}.</small></div></div>
              <div className="range-options" role="radiogroup" aria-label="Rows to import">
                {[
                  ['all', 'Every row', `${dataRows.length} records`],
                  ['first', 'First 10', 'A quick slice'],
                  ['custom', 'Custom range', 'Pick any combination'],
                ].map(([value, label, hint]) => (
                  <label className={rowMode === value ? 'selected' : ''} key={value}>
                    <input type="radio" name="rowMode" value={value} checked={rowMode === value} onChange={() => setRowMode(value)} />
                    <span className="radio-mark"><Check size={13} /></span>
                    <span><strong>{label}</strong><small>{hint}</small></span>
                  </label>
                ))}
              </div>

              <label className={`range-input ${rowMode !== 'custom' ? 'disabled' : ''}`}>
                <span>Rows to include</span>
                <input
                  value={rangeExpression}
                  disabled={rowMode !== 'custom'}
                  onChange={(event) => setRangeExpression(event.target.value)}
                  placeholder="1-10, 14-17, 19-29"
                  aria-describedby={rangeResult.error ? 'range-help range-error' : 'range-help'}
                />
                <small id="range-help">Use commas between single rows or inclusive ranges.</small>
              </label>
              {rangeResult.error ? <p className="inline-error" id="range-error" role="alert"><AlertCircle size={16} /> {rangeResult.error}</p> : <div className="range-success" role="status" aria-live="polite"><CheckCircle2 size={17} /><strong>{rangeResult.indices.length} rows selected</strong><span>in their original file order</span></div>}
              <div className="range-example"><span>Try this</span><button type="button" onClick={() => { setRowMode('custom'); setRangeExpression('1-10, 14-17, 19-29') }}>1-10, 14-17, 19-29</button><small>Selects 25 rows</small></div>
            </div>

            <div className="row-map-card">
              <div className="preview-title"><div><span>Selection map</span><small>First {Math.min(40, dataRows.length)} data rows</small></div><span className="selected-count">{rangeResult.indices.length}/{dataRows.length}</span></div>
              <div className="row-map">
                {dataRows.slice(0, 40).map((_, index) => <span className={rangeResult.indices.includes(index) ? 'selected' : ''} key={index}>{index + 1}</span>)}
              </div>
              <div className="map-legend"><span><i className="selected" /> Included</span><span><i /> Left out</span></div>
              <div className="range-note"><Info size={16} /><p>Ranges are validated before import. Overlaps are safely deduplicated; rows beyond {dataRows.length} are never silently clipped.</p></div>
            </div>
          </div>
        )}

        {step === 3 && parsed && (
          <div className="review-stage stage-enter">
            <h2 className="review-stage-title" ref={stageHeadingRef} tabIndex="-1">Review the rows</h2>
            <div className="review-summary">
              <div><span className="summary-number">{rangeResult.indices.length}</span><span>selected</span></div>
              <div><span className="summary-number good">{reviewedRows.length - invalidCount}</span><span>ready</span></div>
              <div><span className="summary-number warn">{duplicateCount}</span><span>possible duplicates</span></div>
              <div><span className="summary-number bad">{invalidCount}</span><span>need attention</span></div>
            </div>

            {duplicateCount > 0 && (
              <div className="duplicate-policy">
                <div><RotateCcw size={18} /><span><strong>{duplicateCount} possible {duplicateCount === 1 ? 'duplicate' : 'duplicates'}</strong><small>Matched by website + username, or name + username.</small></span></div>
                <div className="policy-toggle">
                  <button type="button" aria-pressed={duplicatePolicy === 'keep'} className={duplicatePolicy === 'keep' ? 'active' : ''} onClick={() => setDuplicatePolicy('keep')}>Keep both</button>
                  <button type="button" aria-pressed={duplicatePolicy === 'skip'} className={duplicatePolicy === 'skip' ? 'active' : ''} onClick={() => setDuplicatePolicy('skip')}>Skip matches</button>
                </div>
              </div>
            )}

            <div className="review-table-card">
              <div role="table" aria-label="Rows ready for import" aria-rowcount={reviewedRows.length + 1} aria-colcount="5">
                <div className="review-table-head" role="row"><span role="columnheader">Source row</span><span role="columnheader">Secret</span><span role="columnheader">Username</span><span role="columnheader">Destination</span><span role="columnheader">Status</span></div>
                <div className="review-list" role="rowgroup">
                  {reviewedRows.slice(0, 50).map((row) => (
                    <div className={`review-row ${!row.valid ? 'invalid' : ''}`} role="row" key={row.sourceIndex}>
                      <span role="cell">{row.sourceIndex + 1}</span>
                      <span role="cell"><i>{(row.name || '?').slice(0, 1).toUpperCase()}</i><strong>{row.name || 'Untitled row'}</strong></span>
                      <span role="cell">{row.username || '—'}</span>
                      <span role="cell">{row.collection}</span>
                      <span role="cell">{!row.valid ? <b className="status-badge error"><AlertCircle size={13} /> {row.problems.join(', ')}</b> : row.duplicate ? <b className="status-badge duplicate">Possible duplicate</b> : <b className="status-badge ready"><Check size={13} /> Ready</b>}</span>
                    </div>
                  ))}
                </div>
              </div>
              {reviewedRows.length > 50 && <div className="review-overflow-note" role="note">Showing the first 50 of {reviewedRows.length} selected rows. All {reviewedRows.length} are included in the totals and import rule.</div>}
            </div>
            <p className="commit-note"><LockKeyhole size={15} /> {encrypted ? 'Ready rows will be encrypted and saved as one atomic update.' : 'You are previewing a demo vault. Create an encrypted vault to persist this import.'}</p>
            {commitError && <p className="inline-error" role="alert"><AlertCircle size={16} /> {commitError}</p>}
          </div>
        )}

        {step === 4 && importResult && (
          <div className="import-complete stage-enter">
            <div className="complete-mark"><Check size={32} /></div>
            <p className="eyebrow">Import complete</p>
            <h2 ref={stageHeadingRef} tabIndex="-1">{importResult.imported} new secrets,<br /><em>neatly put away.</em></h2>
            <p>{importResult.skipped ? `${importResult.skipped} rows were skipped because they were invalid or matched your duplicate rule.` : 'Every selected row was imported successfully.'}</p>
            <div className="complete-stats"><span><strong>{importResult.imported}</strong>Imported</span><span><strong>{importResult.skipped}</strong>Skipped</span><span><strong>0</strong>Uploaded</span></div>
            <div className="complete-actions"><button type="button" className="primary-button" onClick={onDone}>View imported <ArrowRight size={17} /></button><button type="button" className="secondary-button" onClick={resetImport}>Import another file</button></div>
          </div>
        )}
      </section>

      {step > 0 && step < 4 && (
        <footer className="wizard-footer">
          <button type="button" className="back-button" onClick={() => setStep((current) => current - 1)}><ArrowLeft size={17} /> Back</button>
          <div><span>{step === 1 && `${Object.values(mapping).filter(Boolean).length} fields connected`}{step === 2 && `${rangeResult.indices.length} of ${dataRows.length} rows`}{step === 3 && `${validRows.length} ready to import`}</span>
            {step < 3 ? <button type="button" className="primary-button" disabled={(step === 1 && (!mappingComplete || Boolean(parseError))) || (step === 2 && (Boolean(rangeResult.error) || !rangeResult.indices.length))} onClick={() => setStep((current) => current + 1)}>Continue <ArrowRight size={17} /></button> : <button type="button" className="primary-button" disabled={!validRows.length || busy} onClick={commitImport}>{busy ? 'Encrypting…' : `Import ${validRows.length} secrets`} <LockKeyhole size={16} /></button>}
          </div>
        </footer>
      )}
    </main>
  )
}
