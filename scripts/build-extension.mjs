import { build } from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDirectory, '..')
const sourceRoot = join(projectRoot, 'extension')
const outputRoot = join(projectRoot, 'dist-extension')

if (dirname(outputRoot) !== projectRoot || outputRoot === projectRoot) throw new Error('Refusing to clean an unexpected extension output path.')
await rm(outputRoot, { recursive: true, force: true })
await mkdir(join(outputRoot, 'icons'), { recursive: true })

const entries = [
  ['service-worker.js', 'service-worker.js'],
  ['content.js', 'content.js'],
  ['popup.js', 'popup.js'],
  ['options.js', 'options.js'],
]

for (const [sourceName, outputName] of entries) {
  await build({
    entryPoints: [join(sourceRoot, 'src', sourceName)],
    outfile: join(outputRoot, outputName),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    minify: true,
    legalComments: 'none',
    sourcemap: false,
    charset: 'utf8',
  })
}

await Promise.all([
  cp(join(sourceRoot, 'manifest.json'), join(outputRoot, 'manifest.json')),
  cp(join(sourceRoot, 'popup.html'), join(outputRoot, 'popup.html')),
  cp(join(sourceRoot, 'options.html'), join(outputRoot, 'options.html')),
  cp(join(sourceRoot, 'extension.css'), join(outputRoot, 'extension.css')),
  ...[16, 32, 48, 128].map((size) => cp(join(projectRoot, 'public', 'hush-mark.png'), join(outputRoot, 'icons', `hush-${size}.png`))),
])
