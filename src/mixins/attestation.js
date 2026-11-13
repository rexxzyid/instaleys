import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { dumps } from '../utils.js'

export const USDID_REGISTRATION_CLIENT_DOC_ID = '124930351917786857261002920888'
export const USDID_TOKEN_TTL = 3600
export const USDID_REFRESH_MARGIN = 300
export const ATTESTATION_KEYSTORE_ERROR = -1013

const b64u = (raw) => Buffer.from(raw).toString('base64url')

const nowSeconds = () => Math.floor(Date.now() / 1000)

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const findUsdidRegistration = (result) => {
  for (const [key, value] of Object.entries(result.data || {})) {
    if (key.includes('usdid_registration') && isPlainObject(value)) return value
  }
  return {}
}

export const attestationMixin = {
  getUsdidSettings() {
    if (!this.usdidPrivateKey) return {}
    return {
      usdid: this.usdid,
      kid: this.usdidKid,
      private_key: this.usdidPrivateKey,
      registered: this.usdidRegistered
    }
  },

  setUsdidSettings(settings = null) {
    const source = settings || {}
    this.usdid = String(source.usdid || '')
    this.usdidKid = String(source.kid || '')
    this.usdidPrivateKey = String(source.private_key || '')
    this.usdidRegistered = Boolean(source.registered)
    this.attestationChallengeNonce = ''
    this.attestationKeyNonce = ''
    this.usdidHeaderCache = ''
    this.usdidHeaderExpiresAt = 0
    return Boolean(this.usdidPrivateKey)
  },

  usdidGenerate(force = false) {
    if (this.usdidPrivateKey && !force) return this.usdid
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this.usdidPrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' })
    this.usdid = randomUUID()
    this.usdidKid = b64u(randomBytes(32))
    this.usdidRegistered = false
    this.usdidHeaderCache = ''
    this.usdidHeaderExpiresAt = 0
    return this.usdid
  },

  usdidKey() {
    if (!this.usdidPrivateKey) this.usdidGenerate()
    return createPrivateKey(this.usdidPrivateKey)
  },

  usdidSign(message) {
    return sign('sha256', Buffer.from(message), { key: this.usdidKey(), dsaEncoding: 'der' })
  },

  get usdidPublicKeyDer() {
    return createPublicKey(this.usdidKey()).export({ type: 'spki', format: 'der' })
  },

  usdidHeader(ttl = USDID_TOKEN_TTL) {
    const now = nowSeconds()
    if (this.usdidHeaderCache && this.usdidHeaderExpiresAt - now > USDID_REFRESH_MARGIN) {
      return this.usdidHeaderCache
    }
    const expiresAt = now + ttl
    const signedPart = `${this.usdid}.${expiresAt}`
    const value = `${signedPart}.${b64u(this.usdidSign(signedPart))}`
    this.usdidHeaderCache = value
    this.usdidHeaderExpiresAt = expiresAt
    return value
  },

  usdidRegistrationToken(ttl = USDID_TOKEN_TTL) {
    const now = nowSeconds()
    const payload = b64u(
      dumps({
        sub: this.usdid,
        iat: now,
        aud: this.appId,
        exp: now + ttl,
        pub: this.usdidPublicKeyDer.toString('base64'),
        alg: 'ES256'
      })
    )
    const protectedHeader = b64u(
      dumps({ typ: 'JWT', alg: 'ES256', kid: this.usdidKid, aid: this.appId, ver: '1' })
    )
    const token = {
      payload,
      signatures: [
        {
          protected: protectedHeader,
          signature: b64u(this.usdidSign(`${protectedHeader}.${payload}`))
        }
      ]
    }
    return b64u(dumps(token))
  },

  async usdidRegister(clientDocId = USDID_REGISTRATION_CLIENT_DOC_ID) {
    if (!this.usdidPrivateKey) this.usdidGenerate()
    const variables = {
      input: {
        usdid_token: { sensitive_string_value: this.usdidRegistrationToken() },
        fdid: { sensitive_string_value: this.phoneId }
      }
    }
    const result = await this.privateGraphqlWwwRequest({
      friendlyName: 'IGUSDIDRegistrationMutation',
      variables,
      clientDocId,
      extraHeaders: {
        'X-Root-Field-Name': 'usdid_registration',
        'X-Graphql-Client-Library': 'pando'
      }
    })
    this.usdidRegistered = Boolean(findUsdidRegistration(result).success)
    return this.usdidRegistered
  },

  async attestationCreateAndroidKeystore(keyHash = '', domain = null) {
    const opts = {
      withSignature: false,
      headers: { 'X-FB-Friendly-Name': 'IgApi: attestation/create_android_keystore/' },
      login: true
    }
    if (domain) opts.domain = domain
    const result = await this.privateRequest(
      'attestation/create_android_keystore/',
      { app_scoped_device_id: this.uuid, key_hash: keyHash },
      opts
    )
    this.attestationChallengeNonce = String(result.challenge_nonce || '')
    this.attestationKeyNonce = String(result.key_nonce || '')
    return result
  },

  attestationParams(challengeNonce = '') {
    const nonce = challengeNonce || this.attestationChallengeNonce
    if (!nonce) return ''
    return dumps({
      attestation: [
        {
          version: 2,
          type: 'keystore',
          errors: [ATTESTATION_KEYSTORE_ERROR],
          challenge_nonce: nonce,
          signed_nonce: '',
          key_hash: ''
        }
      ]
    })
  }
}
