const LOWERCASE = 'abcdefghijkmnopqrstuvwxyz'
const UPPERCASE = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const NUMBERS = '23456789'
const SYMBOLS = '!@#$%&*-_+?'
const AMBIGUOUS = new Set('Il1O0|`\'"{}[]()/\\')

const PASSPHRASE_WORDS = [
  'acorn', 'alpine', 'amber', 'anchor', 'apple', 'apron', 'arch', 'arrow', 'atlas', 'autumn', 'badger', 'bamboo', 'basin', 'beacon', 'birch', 'bison',
  'blossom', 'bluebird', 'boulder', 'branch', 'breeze', 'bridge', 'brook', 'cabin', 'cactus', 'candle', 'canyon', 'cedar', 'cherry', 'cinder', 'clover', 'coast',
  'cobalt', 'comet', 'copper', 'coral', 'crane', 'creek', 'cricket', 'crystal', 'dahlia', 'dawn', 'delta', 'desert', 'drift', 'dune', 'eagle', 'earth',
  'ember', 'falcon', 'fern', 'field', 'finch', 'fjord', 'flame', 'forest', 'fossil', 'fox', 'frost', 'garden', 'ginger', 'glacier', 'glass', 'glen',
  'grove', 'harbor', 'hazel', 'heather', 'heron', 'hickory', 'horizon', 'island', 'ivy', 'jade', 'juniper', 'kite', 'lagoon', 'lake', 'lantern', 'lark',
  'laurel', 'lemon', 'lilac', 'linen', 'lotus', 'lunar', 'maple', 'marble', 'marsh', 'meadow', 'meteor', 'mist', 'moon', 'moss', 'museum', 'nectar',
  'night', 'north', 'oak', 'oasis', 'ocean', 'olive', 'onyx', 'orchid', 'orbit', 'otter', 'owl', 'paper', 'pebble', 'pepper', 'petal', 'pine',
  'plum', 'pond', 'poppy', 'quartz', 'rain', 'raven', 'reef', 'river', 'robin', 'rose', 'saffron', 'sage', 'sand', 'scarlet', 'shadow', 'shell',
  'shore', 'silver', 'sky', 'slate', 'snow', 'solar', 'sparrow', 'spring', 'spruce', 'star', 'stone', 'storm', 'stream', 'summer', 'summit', 'sunset',
  'tide', 'timber', 'topaz', 'trail', 'tundra', 'valley', 'velvet', 'violet', 'wave', 'willow', 'wind', 'winter', 'wood', 'wren', 'zephyr', 'zinnia',
  'almond', 'anise', 'aster', 'aurora', 'bay', 'berry', 'bloom', 'bramble', 'bronze', 'cello', 'chestnut', 'cloud', 'daisy', 'elm', 'feather', 'flint',
  'harvest', 'indigo', 'iris', 'jasmine', 'kelp', 'lavender', 'mango', 'mint', 'morning', 'mulberry', 'peach', 'pear', 'pinecone', 'prairie', 'reed', 'rosemary',
  'sequoia', 'signal', 'sorrel', 'thistle', 'thyme', 'walnut', 'water', 'wheat', 'yarrow', 'agate', 'bell', 'birchwood', 'canvas', 'castle', 'circle', 'cove',
  'echo', 'granite', 'hill', 'ink', 'islet', 'kestrel', 'lamp', 'mesa', 'opal', 'path', 'peak', 'ripple', 'sail', 'seed', 'terrace', 'vale',
  'acoustic', 'bright', 'calm', 'clear', 'gentle', 'golden', 'green', 'hidden', 'kind', 'mellow', 'quiet', 'rapid', 'soft', 'still', 'swift', 'warm',
  'brisk', 'cool', 'deep', 'early', 'fresh', 'grand', 'light', 'open', 'round', 'small', 'steady', 'tall', 'tidal', 'wild', 'wise', 'young',
]

function randomUint32() {
  return crypto.getRandomValues(new Uint32Array(1))[0]
}

export function randomIndex(maxExclusive) {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > 0x1_0000_0000) {
    throw new Error('Invalid random selection range.')
  }
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive
  let value
  do value = randomUint32()
  while (value >= limit)
  return value % maxExclusive
}

function pick(value) {
  return value[randomIndex(value.length)]
}

function shuffle(characters) {
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1)
    ;[characters[index], characters[swapIndex]] = [characters[swapIndex], characters[index]]
  }
  return characters
}

function filterCharacters(characters, options) {
  const excluded = new Set(String(options.excludedCharacters || ''))
  const allowed = options.allowedCharacters ? new Set(String(options.allowedCharacters)) : null
  return [...characters]
    .filter((character) => !excluded.has(character))
    .filter((character) => !options.avoidAmbiguous || !AMBIGUOUS.has(character))
    .filter((character) => !allowed || allowed.has(character))
    .join('')
}

export function generatePassword(options = {}) {
  const settings = {
    length: 20,
    lowercase: true,
    uppercase: true,
    numbers: true,
    symbols: true,
    avoidAmbiguous: true,
    allowedCharacters: '',
    excludedCharacters: '',
    ...options,
  }
  const length = Number(settings.length)
  if (!Number.isInteger(length) || length < 8 || length > 256) throw new Error('Password length must be between 8 and 256.')

  const requestedGroups = [
    settings.lowercase && LOWERCASE,
    settings.uppercase && UPPERCASE,
    settings.numbers && NUMBERS,
    settings.symbols && SYMBOLS,
  ].filter(Boolean)
  const groups = requestedGroups.map((group) => filterCharacters(group, settings)).filter(Boolean)
  if (!groups.length) throw new Error('Choose at least one character group allowed by the site.')
  if (length < groups.length) throw new Error('The password is too short for the selected character groups.')

  const alphabet = [...new Set(groups.join(''))].join('')
  const result = groups.map(pick)
  while (result.length < length) result.push(pick(alphabet))
  return shuffle(result).join('')
}

export function generatePassphrase(options = {}) {
  const settings = {
    words: 8,
    separator: '-',
    capitalize: false,
    includeNumber: true,
    ...options,
  }
  const count = Number(settings.words)
  if (!Number.isInteger(count) || count < 5 || count > 12) throw new Error('Passphrases must contain between 5 and 12 words.')
  if (!/^[\s._+\-:]{1,3}$/u.test(settings.separator)) throw new Error('Choose a short, non-letter separator.')
  const words = Array.from({ length: count }, () => pick(PASSPHRASE_WORDS))
  if (settings.capitalize) {
    const index = randomIndex(words.length)
    words[index] = `${words[index][0].toUpperCase()}${words[index].slice(1)}`
  }
  if (settings.includeNumber) words.push(String(randomIndex(1000)).padStart(3, '0'))
  return words.join(settings.separator)
}

export const GENERATOR_DEFAULTS = Object.freeze({
  length: 20,
  lowercase: true,
  uppercase: true,
  numbers: true,
  symbols: true,
  avoidAmbiguous: true,
})

