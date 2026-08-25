import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDelimitedText, parseRowRanges, mapImportRows, safeHttpUrl } from '../src/lib/importer.js'

test('parses discontinuous row ranges in original order', () => {
  const result = parseRowRanges('1-10, 14-17, 19-29', 40)
  assert.equal(result.error, '')
  assert.equal(result.indices.length, 25)
  assert.deepEqual(result.indices.slice(0, 3), [0, 1, 2])
  assert.deepEqual(result.indices.slice(-3), [26, 27, 28])
})

test('deduplicates overlapping rows', () => {
  assert.deepEqual(parseRowRanges('3,3,2-4', 10).indices, [1, 2, 3])
})

test('rejects malformed and out-of-range input', () => {
  for (const value of ['7-3', '0', '2-a', '1,', '2.5']) {
    assert.ok(parseRowRanges(value, 8).error, value)
  }
  assert.match(parseRowRanges('1-9', 8).error, /row 8/)
})

test('parses quoted commas, escaped quotes, multiline values, BOM, and CRLF', () => {
  const input = '\uFEFFName,Login,Password,Notes\r\n"Acme, Inc",me,"p,ass","line 1\r\nline 2"\r\n"A ""quote""",u, secret ,ok'
  const { rows, delimiter } = parseDelimitedText(input)
  assert.equal(delimiter, ',')
  assert.equal(rows[1][0], 'Acme, Inc')
  assert.equal(rows[1][3], 'line 1\r\nline 2')
  assert.equal(rows[2][0], 'A "quote"')
})

test('preserves password whitespace during mapping', () => {
  const [mapped] = mapImportRows([[' Acme ', '  secret  ']], { name: '0', password: '1' }, [0])
  assert.equal(mapped.name, 'Acme')
  assert.equal(mapped.password, '  secret  ')
})

test('normalizes host-and-port URLs while rejecting dangerous schemes', () => {
  assert.equal(safeHttpUrl('example.com:8443/path'), 'https://example.com:8443/path')
  assert.equal(safeHttpUrl('localhost:3000'), 'https://localhost:3000/')
  assert.equal(safeHttpUrl('javascript:alert(1)'), '')
  assert.equal(safeHttpUrl('ftp://example.com/file'), '')
})
