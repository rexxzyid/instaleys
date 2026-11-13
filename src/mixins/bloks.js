import { ValidationError } from '../errors.js'
import { dumps } from '../utils.js'

export const bloksMixin = {
  async bloksChallengeTakeChallenge(opts = {}) {
    const {
      challengeContext = '',
      choice = null,
      hasFollowUpScreens = 0,
      extraData = null,
      bloksVersioningId = ''
    } = opts
    const versioningId = bloksVersioningId || this.bloksVersioningId
    if (!versioningId) throw new ValidationError('Client.bloksVersioningId is empty (hash is expected)')
    const data = {
      _uuid: this.uuid,
      has_follow_up_screens: String(hasFollowUpScreens),
      bk_client_context: dumps({ bloks_version: versioningId, styles_id: 'instagram' }),
      bloks_versioning_id: versioningId
    }
    if (challengeContext !== null && challengeContext !== undefined) data.challenge_context = challengeContext
    if (choice !== null && choice !== undefined) data.choice = String(choice)
    if (extraData) Object.assign(data, extraData)
    return this.privateRequest('bloks/apps/com.instagram.challenge.navigation.take_challenge/', data, {
      withSignature: false
    })
  },

  async bloksChangePassword(password, challengeContext) {
    const encPassword = await this.passwordEncrypt(password)
    const result = await this.bloksChallengeTakeChallenge({
      challengeContext,
      extraData: { enc_new_password1: encPassword, enc_new_password2: encPassword }
    })
    return result.status === 'ok'
  }
}
