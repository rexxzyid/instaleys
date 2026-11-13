import { createHash } from 'node:crypto'
import {
  ChallengeError,
  ChallengeRedirection,
  ChallengeRequired,
  ChallengeSelfieCaptcha,
  ChallengeUnknownStep,
  LegacyForceSetNewPasswordForm,
  RecaptchaChallengeForm,
  SelectContactPointRecoveryForm,
  SubmitPhoneNumberForm
} from '../errors.js'
import { HttpSession, encodeForm } from '../http.js'
import { randomBetween, sleep, vassert } from '../utils.js'

export const CHALLENGE_WAIT_SECONDS = 5
export const BLOKS_REDIRECT_ACTION = 'com.bloks.www.ig.challenge.redirect.async'
export const ChallengeChoice = Object.freeze({ SMS: 0, EMAIL: 1 })

const CODE_FORM_TYPES = ['VerifyEmailCodeForm', 'VerifySMSCodeForm', 'VerifySMSCodeFormForSMSCaptcha']
const AUTO_APPROVE_STEPS = ['delta_login_review', 'delta_acknowledge_approved', 'scraping_warning']
const VERIFY_STEPS = [
  'verify_email',
  'verify_email_code',
  'verify_phone',
  'verify_phone_code',
  'verify_sms',
  'verify_sms_code',
  'select_verify_method'
]
const ANY_MEDIA_TYPE = ['*', '*'].join('/')
const WRONG_CODE_MARKER = 'Please check the code we sent you and try again'
const CODE_SUBMIT_RETRIES = 5
const CODE_HANDLER_ATTEMPTS = 10
const CHOICE_RETRIES = 8
const PASSWORD_HANDLER_ATTEMPTS = 24
const WEB_USER_AGENT_PREFIX =
  'Mozilla/5.0 (Linux; Android 8.0.0; MI 5s Build/OPR1.170623.032; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/80.0.3987.149 Mobile Safari/537.36'

const withoutMessage = (json) => {
  const { message, ...rest } = json ?? {}
  return rest
}

const lastJsonText = (json) => JSON.stringify(json)

export const extractMessages = (challenge) => {
  const messages = []
  for (const item of challenge.extraData?.content ?? []) {
    const message = 'title' in item ? item.title : item.text
    if (message) messages.push(`${message}${message.endsWith('.') ? '' : '.'}`)
  }
  return messages
}

export const normalizeChallengeApiPath = (apiPath) => {
  if (apiPath.startsWith('/api/v1/')) return apiPath.slice('/api/v1'.length)
  if (apiPath.startsWith('/api/')) return apiPath.slice('/api'.length)
  return apiPath
}

const legacyChallengeContext = (nonceCode, userId) =>
  `{"step_name": "", "nonce_code": ${JSON.stringify(nonceCode)}, "user_id": ${userId}, "is_stateless": false}`

const challengeParams = (client, challengeUrl, lastJson) => {
  const parts = challengeUrl.split('/').slice(2, 4)
  if (parts.length < 2) return {}
  const [userId, nonceCode] = parts
  if (!/^[-+]?\d+$/.test(userId.trim())) return {}
  const challengeContext =
    lastJson.challenge?.challenge_context || legacyChallengeContext(nonceCode, BigInt(userId.trim()).toString())
  return { guid: client.uuid, device_id: client.androidDeviceId, challenge_context: challengeContext }
}

const contactPointChoice = async (client, challengeUrl) => {
  const steps = Object.keys(client.lastJson.step_data)
  if (steps.includes('email')) {
    await client.sendPrivateRequest(challengeUrl, { choice: String(ChallengeChoice.EMAIL) })
    return ChallengeChoice.EMAIL
  }
  if (steps.includes('phone_number')) {
    await client.sendPrivateRequest(challengeUrl, { choice: String(ChallengeChoice.SMS) })
    return ChallengeChoice.SMS
  }
  throw new ChallengeError(
    `ChallengeResolve: Choice "email" or "phone_number" (sms) not available to this account ${lastJsonText(client.lastJson)}`
  )
}

const ajaxSeed = () => `#PWD_INSTAGRAM_BROWSER:0:${Math.floor(Date.now() / 1000)}:`

const webSessionHeaders = (client) => ({
  'User-Agent': `${WEB_USER_AGENT_PREFIX} ${client.userAgent}`,
  'upgrade-insecure-requests': '1',
  'sec-fetch-dest': 'document',
  accept:
    `text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,${ANY_MEDIA_TYPE};q=0.8,application/signed-exchange;v=b3;q=0.9`,
  'x-requested-with': 'com.instagram.android',
  'sec-fetch-site': 'none',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-user': '?1',
  'accept-encoding': 'gzip, deflate',
  'accept-language': 'en-US,en;q=0.9,en-US;q=0.8,en;q=0.7',
  pragma: 'no-cache',
  'cache-control': 'no-cache'
})

const ajaxHeaders = (client, session, challengeUrl, instagramAjax) => ({
  'x-ig-www-claim': '0',
  'x-instagram-ajax': instagramAjax,
  'content-type': 'application/x-www-form-urlencoded',
  accept: ANY_MEDIA_TYPE,
  'sec-fetch-dest': 'empty',
  'x-requested-with': 'XMLHttpRequest',
  'x-csrftoken': session.cookies.get('csrftoken'),
  'x-ig-app-id': client.appId,
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  referer: challengeUrl
})

const createWebForm = (client, session) => {
  const headers = webSessionHeaders(client)
  return {
    headers,
    async get(url) {
      return session.request('GET', url, { headers })
    },
    async post(url, data) {
      const response = await session.request('POST', url, { headers, body: encodeForm(data) })
      return response.json()
    }
  }
}

const reviewContactDetails = (result) => {
  const details = []
  for (const data of result.extraData?.content ?? []) {
    for (const entry of data.labeled_list_entries ?? []) {
      let value = entry.list_item_text
      if (!value) continue
      if (!value.includes('@')) value = value.replaceAll(' ', '').replaceAll('-', '')
      details.push(value)
    }
  }
  return details
}

const isWrongCode = (result) => ((result.errors || [''])[0] ?? '').includes(WRONG_CODE_MARKER)

export const challengeMixin = {
  challengeWait(multiplier = 1) {
    return sleep(this.challengeWaitSeconds * multiplier * 1000)
  },

  challengeHttpSession() {
    return new HttpSession({ verify: this.tlsVerify, proxy: this.private.proxy })
  },

  async challengeCodeOrRaised(choice, attempts = 24) {
    const errorContext = withoutMessage(this.lastJson)
    if (attempts <= 0) {
      throw new ChallengeRequired('Challenge code was not provided before the retry window expired.', errorContext)
    }
    const code = await this.challengeCodeHandler(this.username, choice)
    if (code) {
      this.logger.info(`Code entered for ${this.username}`)
      return code
    }
    throw new ChallengeRequired(
      'Challenge code required. Provide it via challengeCodeHandler or retry login after saving client settings.',
      errorContext
    )
  },

  raiseBloksRedirectRequired() {
    throw new ChallengeRequired(
      'Manual verification required via Instagram Bloks redirect checkpoint. Please confirm the login in the official Instagram app or web flow on a trusted device, then retry with the same saved client settings, device identifiers, and proxy/IP.',
      withoutMessage(this.lastJson)
    )
  },

  async challengeResolveChangePassword() {
    const challengeContext = this.lastJson.challenge_context
    if (!challengeContext) {
      throw new ChallengeRequired(
        'Password change required, but Instagram did not return a challenge context. Complete the flow manually.',
        withoutMessage(this.lastJson)
      )
    }
    let password = null
    let attempt = 0
    for (; attempt < PASSWORD_HANDLER_ATTEMPTS; attempt += 1) {
      password = await this.changePasswordHandler(this.username)
      if (password) break
      await this.challengeWait()
    }
    if (!password) {
      throw new ChallengeRequired(
        'Password change required. Provide a new password via changePasswordHandler or complete the flow manually.',
        withoutMessage(this.lastJson)
      )
    }
    this.logger.info(
      `New password (${password.length} chars) entered for ${this.username} (${attempt} attempts by ${CHALLENGE_WAIT_SECONDS} seconds)`
    )
    return this.bloksChangePassword(password, challengeContext)
  },

  async applyBloksChallengeResult(result) {
    if (result && typeof result === 'object' && !Array.isArray(result)) this.lastJson = result
    if (this.lastJson.status !== 'ok') this.raiseBloksRedirectRequired()
    if (this.lastJson.action === 'close' || this.lastJson.type === 'CHALLENGE_REDIRECTION') return true
    if (this.lastJson.bloks_action === BLOKS_REDIRECT_ACTION) this.raiseBloksRedirectRequired()
    return false
  },

  async challengeBloksRedirectDismiss() {
    if (this.lastJson.bloks_action !== BLOKS_REDIRECT_ACTION || !this.lastJson.challenge_context) {
      throw new ChallengeRequired(
        'No pending Bloks redirect challenge context found. Retry the original login/request first, then approve it in the official app.',
        withoutMessage(this.lastJson)
      )
    }
    const result = await this.bloksChallengeTakeChallenge({ challengeContext: this.lastJson.challenge_context })
    await this.applyBloksChallengeResult(result)
    return true
  },

  async resolveChallenge(lastJson) {
    const apiPath = lastJson?.challenge?.api_path
    if (typeof apiPath !== 'string') {
      throw new ChallengeRequired('Challenge payload has no challenge.api_path to resolve.', withoutMessage(lastJson))
    }
    const challengeUrl = normalizeChallengeApiPath(apiPath)
    if (challengeUrl.startsWith('/auth_platform/')) {
      throw new ChallengeRequired(
        'Manual verification required via Instagram auth platform flow. This challenge is not yet supported automatically.',
        withoutMessage(lastJson)
      )
    }
    if (lastJson.challenge?.native_flow && challengeUrl.startsWith('/challenge/')) {
      throw new ChallengeRequired(
        'Manual verification required via Instagram native challenge flow. This checkpoint is not handled by challengeCodeHandler or changePasswordHandler; complete it in the official Instagram app or web flow on a trusted device. Retry with the same saved client settings, device identifiers, and proxy/IP.',
        { ...withoutMessage(lastJson), raw_message: 'challenge_required' }
      )
    }
    const params = challengeParams(this, challengeUrl, lastJson)
    try {
      await this.sendPrivateRequest(challengeUrl.replace(/^\/+/, ''), null, { params })
    } catch (error) {
      if (!(error instanceof ChallengeRequired)) throw error
      vassert(this.lastJson.message === 'challenge_required', lastJsonText(this.lastJson))
      return this.challengeResolveContactForm(challengeUrl)
    }
    return this.challengeResolveSimple(challengeUrl)
  },

  async challengeSelectContactPoint(form, url) {
    let choice = ChallengeChoice.EMAIL
    let result = await form.post(url, { choice })
    for (let retry = 0; retry < CHOICE_RETRIES; retry += 1) {
      await this.challengeWait()
      try {
        result = this.handleChallengeResult(result)
        break
      } catch (error) {
        if (error instanceof SelectContactPointRecoveryForm) {
          if (choice === ChallengeChoice.SMS) throw error
          choice = ChallengeChoice.SMS
          result = await form.post(url, { choice })
          continue
        }
        if (error instanceof SubmitPhoneNumberForm) {
          result = await form.post(url, {
            phone_number: error.challenge.fields.phone_number,
            challenge_context: error.challenge.challenge_context
          })
          break
        }
        if (error instanceof ChallengeRedirection) return { redirected: true }
        throw error
      }
    }
    return { choice, result }
  },

  async challengeSubmitWebCode(form, url, choice) {
    let result = null
    for (let retry = 0; retry < CODE_SUBMIT_RETRIES; retry += 1) {
      let code = null
      for (let attempt = 1; attempt <= CODE_HANDLER_ATTEMPTS; attempt += 1) {
        code = await this.challengeCodeHandler(this.username, choice)
        if (code) break
        await this.challengeWait(attempt)
      }
      if (!code) {
        throw new ChallengeRequired(
          'Challenge code required to continue contact-form verification. Provide it via challengeCodeHandler or retry after manual verification.',
          withoutMessage(this.lastJson)
        )
      }
      await this.challengeWait()
      const response = await form.post(url, { security_code: code })
      result = response.challenge ?? response
      if (!isWrongCode(result)) break
    }
    return result
  },

  async challengeResolveContactForm(challengePath) {
    const challengeUrl = `https://i.instagram.com${challengePath}`
    const seed = ajaxSeed()
    const instagramAjax = createHash('sha256').update(seed).digest('hex').slice(0, 12)
    const session = this.challengeHttpSession()
    for (const key of ['mid', 'csrftoken']) {
      const value = this.private.cookies.get(key)
      if (value !== undefined) session.cookies.set(key, value)
    }
    const form = createWebForm(this, session)
    await this.challengeWait()
    await form.get(challengeUrl)
    Object.assign(form.headers, ajaxHeaders(this, session, challengeUrl, instagramAjax))
    await this.challengeWait()
    const selection = await this.challengeSelectContactPoint(form, challengeUrl)
    if (selection.redirected) return true
    if (!CODE_FORM_TYPES.includes(selection.result.challengeType)) {
      throw new ChallengeError(
        `Unexpected contact-form challenge step after verification selection: ${lastJsonText(selection.result)}`
      )
    }
    const result = await this.challengeSubmitWebCode(form, challengeUrl, selection.choice)
    if (result.challengeType === 'LegacyForceSetNewPasswordForm') this.challengeResolveNewPasswordForm(result)
    if (result.challengeType !== 'ReviewContactPointChangeForm') {
      throw new ChallengeError(
        `Unexpected contact-form challenge step after security code submission: ${lastJsonText(result)}`
      )
    }
    const details = reviewContactDetails(result)
    for (const detail of [this.username, this.email, this.phoneNumber]) {
      if (detail && !details.includes(detail)) {
        throw new ChallengeError(`ChallengeResolve: Data invalid: "${detail}" not in ${JSON.stringify(details)}`)
      }
    }
    const forward = (result.navigation || {}).forward
    if (!forward) throw new ChallengeError('Contact-form challenge response did not provide a forward navigation target.')
    await this.challengeWait()
    const final = await form.post(`https://i.instagram.com${forward}`, {
      choice: 0,
      enc_new_password1: seed,
      new_password1: '',
      enc_new_password2: seed,
      new_password2: ''
    })
    if (final.type !== 'CHALLENGE_REDIRECTION' || final.status !== 'ok') {
      throw new ChallengeError(`Unexpected final response after contact-form approval: ${lastJsonText(final)}`)
    }
    return true
  },

  challengeResolveNewPasswordForm(result) {
    const message = [
      'Log into your Instagram account from smartphone and change password!',
      ...extractMessages(result)
    ].join(' ')
    throw new LegacyForceSetNewPasswordForm(message)
  },

  handleChallengeResult(input) {
    let challenge = input
    if ('challenge' in challenge) {
      challenge = challenge.challenge
      if (!challenge || typeof challenge !== 'object' || Array.isArray(challenge)) {
        throw new ChallengeError('Malformed nested challenge payload received from Instagram.')
      }
    }
    const challengeType = challenge.challengeType
    if (challengeType === 'SelectContactPointRecoveryForm') {
      const messages = []
      if ('extraData' in challenge) messages.push(...extractMessages(challenge))
      if ('errors' in challenge) messages.push(...challenge.errors)
      throw new SelectContactPointRecoveryForm(messages.join(' '), { challenge })
    }
    if (challengeType === 'RecaptchaChallengeForm') {
      throw new RecaptchaChallengeForm((challenge.errors ?? []).join('. '))
    }
    if (CODE_FORM_TYPES.includes(challengeType)) return challenge
    if (challengeType === 'SubmitPhoneNumberForm') throw new SubmitPhoneNumberForm('', { challenge })
    if (challengeType) {
      const messages = [`Unsupported challenge type: ${challengeType}.`]
      if (challenge.extraData) messages.push(...extractMessages(challenge))
      if ('errors' in challenge) messages.push(challenge.errors.join('\n'))
      messages.push('(Please manual login)')
      throw new ChallengeError(messages.join(' '))
    }
    if (challenge.type === 'CHALLENGE_REDIRECTION') throw new ChallengeRedirection('CHALLENGE_REDIRECTION')
    return challenge
  },

  async challengeVerifyCode(challengeUrl, stepName) {
    let url = challengeUrl
    let choice = stepName.includes('phone') || stepName.includes('sms') ? ChallengeChoice.SMS : ChallengeChoice.EMAIL
    if (stepName === 'select_verify_method') {
      url = challengeUrl.slice(1)
      choice = await contactPointChoice(this, url)
    }
    const code = await this.challengeCodeOrRaised(choice, 24)
    await this.sendPrivateRequest(url, { security_code: code })
    vassert((this.lastJson.action ?? '') === 'close', lastJsonText(this.lastJson))
    vassert((this.lastJson.status ?? '') === 'ok', lastJsonText(this.lastJson))
    return true
  },

  async challengeSubmitPhone(challengeUrl, stepName) {
    if (!this.phoneNumber) {
      throw new ChallengeRequired(
        'Phone number required to continue submit_phone challenge. Set client.phoneNumber or complete the flow manually.',
        withoutMessage(this.lastJson)
      )
    }
    await this.sendPrivateRequest(challengeUrl, { phone_number: this.phoneNumber })
    if (this.lastJson.step_name === stepName) {
      throw new ChallengeError(
        `submit_phone challenge did not advance after phone submission: ${lastJsonText(this.lastJson)}`
      )
    }
    return this.challengeResolveSimple(challengeUrl)
  },

  async challengeBloksRedirect(challengeUrl) {
    if (this.lastJson.challenge_type_enum_str === 'PASSWORD_RESET') return this.challengeResolveChangePassword()
    const challengeContext = this.lastJson.challenge_context
    if (!challengeContext) this.raiseBloksRedirectRequired()
    const result = await this.bloksChallengeTakeChallenge({ challengeContext, choice: 0 })
    if (await this.applyBloksChallengeResult(result)) return true
    if (this.lastJson.step_name) return this.challengeResolveSimple(challengeUrl)
    return true
  },

  async challengeContactPointRecovery(challengeUrl) {
    const url = challengeUrl.slice(1)
    const choice = await contactPointChoice(this, url)
    const code = await this.challengeCodeOrRaised(choice, 24)
    await this.sendPrivateRequest(url, { security_code: code })
    if ((this.lastJson.action ?? '') === 'close') {
      vassert((this.lastJson.status ?? '') === 'ok', lastJsonText(this.lastJson))
      return true
    }
    if (this.lastJson.step_name !== 'review_contact_point_change') {
      throw new ChallengeError(
        `Unexpected final challenge step after contact point recovery: ${this.lastJson.step_name}`
      )
    }
    await this.sendPrivateRequest(url, { choice: 0 })
    return true
  },

  async challengeResolveSimple(challengeUrl) {
    const stepName = this.lastJson.step_name ?? ''
    if (AUTO_APPROVE_STEPS.includes(stepName)) {
      await this.sendPrivateRequest(challengeUrl, { choice: '0' })
      return true
    }
    if (stepName === 'add_birthday') {
      await this.sendPrivateRequest(challengeUrl, {
        birthday_year: String(randomBetween(1970, 2004)),
        birthday_month: String(randomBetween(1, 12)),
        birthday_day: String(randomBetween(1, 28))
      })
      return true
    }
    if (VERIFY_STEPS.includes(stepName)) return this.challengeVerifyCode(challengeUrl, stepName)
    if (stepName === 'submit_phone') return this.challengeSubmitPhone(challengeUrl, stepName)
    if (this.lastJson.bloks_action === BLOKS_REDIRECT_ACTION) return this.challengeBloksRedirect(challengeUrl)
    if (stepName === '') {
      vassert((this.lastJson.action ?? '') === 'close', lastJsonText(this.lastJson))
      vassert((this.lastJson.status ?? '') === 'ok', lastJsonText(this.lastJson))
      return true
    }
    if (stepName === 'change_password') return this.challengeResolveChangePassword()
    if (stepName === 'ufac_www_bloks') {
      throw new ChallengeRequired(
        'Manual verification required via Instagram UFAC web bloks checkpoint. Please resolve it in the Instagram app or web flow and then retry.',
        withoutMessage(this.lastJson)
      )
    }
    if (stepName === 'selfie_captcha') throw new ChallengeSelfieCaptcha(lastJsonText(this.lastJson))
    if (stepName === 'select_contact_point_recovery') return this.challengeContactPointRecovery(challengeUrl)
    throw new ChallengeUnknownStep(
      `ChallengeResolve: Unknown step_name "${stepName}" for "${this.username}" in challenge resolver: ${lastJsonText(this.lastJson)}`
    )
  }
}
