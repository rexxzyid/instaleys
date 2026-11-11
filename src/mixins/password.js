import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto'
import { ClientError } from '../errors.js'

export const passwordMixin = {
  async passwordEncrypt(password) {
    const [publicKeyId, publicKey] = await this.passwordPublicKeys()
    const sessionKey = randomBytes(32)
    const iv = randomBytes(12)
    const timestamp = String(Math.floor(Date.now() / 1000))
    const pem = Buffer.from(publicKey, 'base64').toString('utf8')
    const rsaEncrypted = publicEncrypt(
      { key: createPublicKey(pem), padding: constants.RSA_PKCS1_PADDING },
      sessionKey
    )
    const cipher = createCipheriv('aes-256-gcm', sessionKey, iv)
    cipher.setAAD(Buffer.from(timestamp))
    const aesEncrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    const sizeBuffer = Buffer.alloc(2)
    sizeBuffer.writeUInt16LE(rsaEncrypted.length)
    const payload = Buffer.concat([
      Buffer.from([1, publicKeyId]),
      iv,
      sizeBuffer,
      rsaEncrypted,
      tag,
      aesEncrypted
    ]).toString('base64')
    return `#PWD_INSTAGRAM:4:${timestamp}:${payload}`
  },

  async passwordPublicKeys() {
    let failure = null
    try {
      this.privateRequestsCount += 1
      await this.sendPrivateRequest(
        'launcher/sync/',
        { id: this.uuid, server_config_retrieval: '1' },
        {
          login: true,
          headers: this.authorization ? { Authorization: this.authorization } : null,
          returnResponse: true
        }
      )
    } catch (error) {
      if (!(error instanceof ClientError)) throw error
      failure = error
    }
    const headers = this.lastResponse?.headers
    const publicKeyId = headers?.get('ig-set-password-encryption-key-id')
    const publicKey = headers?.get('ig-set-password-encryption-pub-key')
    if (!publicKeyId || !publicKey) {
      throw new ClientError('Instagram did not return the password encryption key', {
        response: this.lastResponse,
        cause: failure
      })
    }
    return [Number(publicKeyId), publicKey]
  }
}
