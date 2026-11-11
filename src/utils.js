import { randomBytes, randomInt, randomUUID } from 'node:crypto'

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const DIGITS = '0123456789'
const PUNCTUATION = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const randomUniform = (min, max) => min + Math.random() * (max - min)

export const randomBetween = (min, max) => randomInt(min, max + 1)

export const randomDelay = (delayRange) => sleep(randomUniform(delayRange[0], delayRange[1]) * 1000)

export const quotePlus = (value) =>
  encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+')

export const dumps = (data) =>
  JSON.stringify(data, function replacer(key, value) {
    const raw = this[key]
    if (raw instanceof Date) return Math.floor(raw.getTime() / 1000)
    if (raw instanceof Set) return [...raw]
    return value
  }).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

export const generateSignature = (data) => `signed_body=SIGNATURE.${quotePlus(data)}`

export const genToken = (size = 10, symbols = false) => {
  const chars = LETTERS + DIGITS + (symbols ? PUNCTUATION : '')
  const bytes = randomBytes(size)
  let out = ''
  for (let i = 0; i < size; i += 1) out += chars[bytes[i] % chars.length]
  return out
}

export const genPassword = (size = 10) => genToken(size)

export const generateJazoest = (symbols) => {
  let amount = 0
  for (const ch of symbols) amount += ch.codePointAt(0)
  return `2${amount}`
}

export const generateUuid = (prefix = '', suffix = '') => `${prefix}${randomUUID()}${suffix}`

export const dateTimeOriginal = (date = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.000Z`
}

export const jsonValue = (data, path, defaultValue = null) => {
  let cur = data
  for (const key of path) {
    if (cur === null || cur === undefined) return defaultValue
    cur = cur[key]
    if (cur === null || cur === undefined) return defaultValue
  }
  return cur
}

export const vassert = (condition, message) => {
  if (!condition) throw new Error(message)
}

export const InstagramIdCodec = {
  ENCODING_CHARS: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',

  encode(num, alphabet = InstagramIdCodec.ENCODING_CHARS) {
    let value = BigInt(num)
    if (value === 0n) return alphabet[0]
    const base = BigInt(alphabet.length)
    const out = []
    while (value > 0n) {
      out.push(alphabet[Number(value % base)])
      value /= base
    }
    return out.reverse().join('')
  },

  decode(shortcode, alphabet = InstagramIdCodec.ENCODING_CHARS) {
    const base = BigInt(alphabet.length)
    let num = 0n
    for (const ch of shortcode) {
      const index = alphabet.indexOf(ch)
      if (index < 0) throw new Error(`Invalid character "${ch}" in shortcode`)
      num = num * base + BigInt(index)
    }
    return num
  }
}

export async function* iterPaginated(fetchPage, { amount = 0, pageSize = 0, initialCursor = null, itemKey = null } = {}) {
  let cursor = initialCursor
  let yielded = 0
  const seen = new Set()
  while (true) {
    let pageAmount = pageSize
    if (amount) {
      const remaining = amount - yielded
      if (remaining <= 0) return
      pageAmount = pageSize ? Math.min(pageSize, remaining) : remaining
    }
    const [items, nextCursor] = await fetchPage(cursor, pageAmount)
    for (const item of items) {
      if (itemKey) {
        const key = itemKey(item)
        if (seen.has(key)) continue
        seen.add(key)
      }
      yield item
      yielded += 1
      if (amount && yielded >= amount) return
    }
    if (!nextCursor || nextCursor === cursor) return
    cursor = nextCursor
  }
}
