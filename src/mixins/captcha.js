import { CaptchaChallengeRequired } from '../errors.js'

const CAPTCHA_DETAIL_KEYS = ['site_key', 'page_url', 'challenge_type', 'raw_challenge_json']

const pickCaptchaDetails = (challengeDetails) =>
  Object.fromEntries(CAPTCHA_DETAIL_KEYS.map((key) => [key, challengeDetails[key] ?? null]))

const callCaptchaHandler = async (handler, challengeDetails) => {
  try {
    return await handler(pickCaptchaDetails(challengeDetails))
  } catch (error) {
    if (error instanceof CaptchaChallengeRequired) throw error
    throw new CaptchaChallengeRequired('', {
      message: `Captcha handler raised an unexpected exception: ${error?.message ?? error}`,
      challenge_details: challengeDetails,
      cause: error
    })
  }
}

export const captchaMixin = {
  setCaptchaHandler(handler) {
    this.captchaHandlerInstance = handler ?? null
  },

  async captchaResolve(challengeDetails = {}) {
    if (!this.captchaHandlerInstance) {
      throw new CaptchaChallengeRequired('', {
        message: 'No captcha handler is configured. Use client.setCaptchaHandler() to set one.',
        challenge_details: challengeDetails
      })
    }
    const token = await callCaptchaHandler(this.captchaHandlerInstance, challengeDetails)
    if (typeof token === 'string' && token) return token
    throw new CaptchaChallengeRequired('', {
      message: 'Captcha handler ran but did not return a valid token string.',
      challenge_details: challengeDetails
    })
  }
}
