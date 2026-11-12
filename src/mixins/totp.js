import { createHmac } from 'node:crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const DEFAULT_DIGITS = 6
const DEFAULT_DIGEST = 'sha1'
const DEFAULT_INTERVAL = 30
const DEFAULT_PADDING = 8
const DYNAMIC_TRUNCATION_MASK = 0x0f
const SIGNIFICANT_BIT_MASK = 0x7f

const decodeBase32 = (secret) => {
  const normalized = secret.replace(/=+$/, '').toUpperCase()
  let bits = 0
  let value = 0
  const bytes = []
  for (const character of normalized) {
    const digit = BASE32_ALPHABET.indexOf(character)
    if (digit === -1) throw new Error(`Invalid base32 character: ${character}`)
    value = (value << 5) | digit
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
      value &= (1 << bits) - 1
    }
  }
  return Buffer.from(bytes)
}

const intToBytestring = (input, padding = DEFAULT_PADDING) => {
  let remaining = BigInt(input)
  const bytes = []
  while (remaining !== 0n) {
    bytes.push(Number(remaining & 0xffn))
    remaining >>= 8n
  }
  const body = Buffer.from(bytes.reverse())
  if (body.length >= padding) return body
  return Buffer.concat([Buffer.alloc(padding - body.length), body])
}

export class TOTP {
  constructor(secret, { digits = DEFAULT_DIGITS, digest = DEFAULT_DIGEST, name = null, issuer = null } = {}) {
    this.digits = digits
    this.digest = digest
    this.secret = secret
    this.name = name || 'Secret'
    this.issuer = issuer
    this.interval = DEFAULT_INTERVAL
  }

  generateOtp(input) {
    if (input < 0) throw new RangeError('input must be positive integer')
    const hmacHash = createHmac(this.digest, this.byteSecret()).update(TOTP.intToBytestring(input)).digest()
    const offset = hmacHash[hmacHash.length - 1] & DYNAMIC_TRUNCATION_MASK
    const code =
      ((hmacHash[offset] & SIGNIFICANT_BIT_MASK) << 24) |
      ((hmacHash[offset + 1] & 0xff) << 16) |
      ((hmacHash[offset + 2] & 0xff) << 8) |
      (hmacHash[offset + 3] & 0xff)
    return String(code % 10 ** this.digits).padStart(this.digits, '0')
  }

  byteSecret() {
    return decodeBase32(this.secret)
  }

  code() {
    return this.generateOtp(Math.floor(Date.now() / 1000 / this.interval))
  }

  static intToBytestring(input, padding = DEFAULT_PADDING) {
    return intToBytestring(input, padding)
  }
}

export const totpMixin = {
  async totpGenerateSeed() {
    const result = await this.privateRequest('accounts/generate_two_factor_totp_key/', this.withDefaultData({}))
    return result.totp_seed
  },

  async totpEnable(verificationCode) {
    const result = await this.privateRequest(
      'accounts/enable_totp_two_factor/',
      this.withDefaultData({ verification_code: verificationCode })
    )
    return result.backup_codes
  },

  async totpDisable() {
    const result = await this.privateRequest('accounts/disable_totp_two_factor/', this.withDefaultData({}))
    return result.status === 'ok'
  },

  totpGenerateCode(seed) {
    return new TOTP(seed).code()
  }
}
