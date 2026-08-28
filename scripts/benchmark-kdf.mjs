import { benchmarkArgon2id } from '../src/lib/vaultCryptoCore.js'

const result = await benchmarkArgon2id({ targetMs: 750 })
const output = {
  runtime: `${process.platform} ${process.arch} · Node ${process.version}`,
  measuredAt: new Date().toISOString(),
  targetMs: result.targetMs,
  selected: result.selected,
  measurements: result.measurements,
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)

