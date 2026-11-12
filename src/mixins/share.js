import { ValidationError } from '../errors.js'

const decodeUtf8IgnoringInvalidBytes = (code) => {
  const base64Text = Buffer.isBuffer(code) ? code.toString('latin1') : String(code)
  return Buffer.from(base64Text, 'base64')
    .toString('utf8')
    .replace(/\uFFFD/g, '')
    .replace(/\u001d/g, '')
}

const pathOfUrl = (url) => {
  try {
    return new URL(url).pathname
  } catch {
    return String(url).split(/[?#]/)[0]
  }
}

export const shareMixin = {
  shareInfo(code) {
    if (typeof code !== 'string' && !Buffer.isBuffer(code)) {
      throw new ValidationError(`Invalid share code type=${typeof code}`)
    }
    const parts = decodeUtf8IgnoringInvalidBytes(code).split(':')
    if (parts.length < 2) throw new ValidationError(`Invalid share code="${String(code)}"`)
    return { type: parts[0], pk: parts[1] }
  },

  shareInfoByUrl(url) {
    return this.shareInfo(this.shareCodeFromUrl(url))
  },

  shareCodeFromUrl(url) {
    const parts = pathOfUrl(url)
      .split('/')
      .filter((part) => part)
    return parts.pop()
  }
}
