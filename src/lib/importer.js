const DELIMITERS = [',', ';', '\t']

export function columnLabel(index) {
  let value = index + 1
  let label = ''
  while (value > 0) {
    value -= 1
    label = String.fromCharCode(65 + (value % 26)) + label
    value = Math.floor(value / 26)
  }
  return label
}

function parseWithDelimiter(source, delimiter) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]

    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        cell += char
      }
      continue
    }

    if (char === '"' && cell.length === 0) {
      quoted = true
    } else if (char === delimiter) {
      row.push(cell)
      cell = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += char
    }
  }

  if (quoted) throw new Error('The file ends inside a quoted value.')
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }

  return rows.filter((candidate) => candidate.some((value) => value.length > 0))
}

function scoreDelimiter(source, delimiter) {
  try {
    const sample = parseWithDelimiter(source.slice(0, 80_000), delimiter).slice(0, 20)
    if (!sample.length) return -1
    const counts = sample.map((row) => row.length)
    const frequencies = new Map()
    counts.forEach((count) => frequencies.set(count, (frequencies.get(count) || 0) + 1))
    const [commonWidth, commonCount] = [...frequencies.entries()].sort((a, b) => b[1] - a[1])[0]
    return commonWidth > 1 ? commonCount * 100 + commonWidth : 0
  } catch {
    return -1
  }
}

export function parseDelimitedText(input, requestedDelimiter = 'auto') {
  const source = String(input ?? '').replace(/^\uFEFF/, '')
  if (!source.trim()) throw new Error('This file is empty.')

  const delimiter = requestedDelimiter === 'auto'
    ? DELIMITERS.map((candidate) => [candidate, scoreDelimiter(source, candidate)])
      .sort((a, b) => b[1] - a[1])[0][0]
    : requestedDelimiter

  const rows = parseWithDelimiter(source, delimiter)
  if (!rows.length) throw new Error('No rows could be read from this file.')

  const width = Math.max(...rows.map((row) => row.length))
  const normalizedRows = rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ''))
  return { rows: normalizedRows, delimiter, columnCount: width }
}

export function parseRowRanges(expression, maxRows) {
  const source = String(expression ?? '').trim()
  const limit = Number(maxRows)
  if (!source) {
    return { indices: [], error: 'Enter at least one row or range.' }
  }
  if (!Number.isInteger(limit) || limit < 1) {
    return { indices: [], error: 'There are no data rows to select.' }
  }

  const selected = new Set()
  const tokens = source.split(',')

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].trim()
    if (!token) {
      return { indices: [], error: `Range ${index + 1} is empty. Remove the extra comma.` }
    }
    const match = token.match(/^(\d+)(?:\s*-\s*(\d+))?$/)
    if (!match) {
      return { indices: [], error: `“${token}” is not a row or range. Try 4 or 4-12.` }
    }
    const start = Number(match[1])
    const end = Number(match[2] ?? match[1])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < 1) {
      return { indices: [], error: `“${token}” must use positive whole numbers.` }
    }
    if (start > end) {
      return { indices: [], error: `“${token}” runs backwards. Put the smaller row first.` }
    }
    if (end > limit) {
      return { indices: [], error: `“${token}” exceeds row ${limit}, the last data row.` }
    }
    for (let value = start; value <= end; value += 1) selected.add(value - 1)
  }

  return { indices: [...selected].sort((a, b) => a - b), error: '' }
}

const HEADER_PATTERNS = {
  name: /^(name|title|account|service|site|login name)$/i,
  username: /^(user(name)?|login|email|e-mail)$/i,
  password: /^(pass(word)?|secret|pwd)$/i,
  url: /^(url|uri|website|site url|login url)$/i,
  notes: /^(note|notes|comment|comments)$/i,
  collection: /^(folder|collection|group|category)$/i,
}

export function suggestMappings(headers) {
  const used = new Set()
  const result = {}
  Object.entries(HEADER_PATTERNS).forEach(([field, pattern]) => {
    const match = headers.findIndex((header, index) => !used.has(index) && pattern.test(String(header).trim()))
    if (match >= 0) {
      result[field] = String(match)
      used.add(match)
    }
  })
  return result
}

export function mapImportRows(rows, mapping, selectedIndices) {
  return selectedIndices.map((sourceIndex) => {
    const source = rows[sourceIndex] || []
    const read = (field, preserve = false) => {
      const column = Number(mapping[field])
      const value = Number.isInteger(column) ? String(source[column] ?? '') : ''
      return preserve ? value : value.trim()
    }
    const name = read('name')
    const password = read('password', true)
    const item = {
      sourceIndex,
      name,
      username: read('username'),
      password,
      url: read('url'),
      notes: read('notes', true).replace(/\r\n?/g, '\n'),
      collection: read('collection') || 'Imported',
    }
    const problems = []
    if (!name) problems.push('Missing name')
    if (!password) problems.push('Missing password')
    return { ...item, problems, valid: problems.length === 0 }
  })
}

export function safeHttpUrl(value) {
  if (!value) return ''
  try {
    const source = String(value).trim()
    if (/^(javascript|data|vbscript|file):/i.test(source)) return ''
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(source) && !/^https?:\/\//i.test(source)) return ''
    const withProtocol = /^https?:\/\//i.test(source) ? source : `https://${source}`
    const parsed = new URL(withProtocol)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : ''
  } catch {
    return ''
  }
}
