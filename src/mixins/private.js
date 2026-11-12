import { API_DOMAIN } from '../config.js'
import {
  AccountContactPointRequired,
  AccountEditError,
  AccountSuspended,
  BadPassword,
  ChallengeRequired,
  ClientBadRequestError,
  ClientConnectionError,
  ClientError,
  ClientForbiddenError,
  ClientIncompleteReadError,
  ClientJSONDecodeError,
  ClientNeedsUpgradeError,
  ClientNotFoundError,
  ClientRequestTimeout,
  ClientThrottledError,
  ClientUnauthorizedError,
  DirectMessageRequestsDisabled,
  FeedbackRequired,
  InvalidMediaId,
  InvalidTargetUser,
  LoginRequired,
  MediaUnavailable,
  PleaseWaitFewMinutes,
  PrivateAccount,
  ProxyAddressIsBlocked,
  RateLimitError,
  SentryBlock,
  TwoFactorRequired,
  UnknownError,
  UserNotFound,
  VideoTooLongException
} from '../errors.js'
import { encodeForm } from '../http.js'
import { dumps, generateSignature, randomDelay, randomUniform, sleep } from '../utils.js'

const DM_DISABLED_MARKERS = [
  "can't message this account unless they follow you",
  "can't receive your message because they don't allow new message requests",
  "doesn't allow new message requests",
  "don't allow new message requests",
  'does not allow new message requests'
]

const CONTACT_POINT_MARKERS = ['need an email or confirmed phone number']

const LOGIN_CONTEXT_HINT =
  'This can also happen when Instagram rejects the proxy/IP, device fingerprint, or login context, even if the password is correct.'

const messageText = (message) => {
  if (message === null || message === undefined) return ''
  if (typeof message === 'string') return message
  if (Array.isArray(message)) return message.map(String).join(' ')
  if (typeof message === 'object') {
    if (Array.isArray(message.errors)) return message.errors.map(String).join(' ')
    return Object.values(message).map(String).join(' ')
  }
  return String(message)
}

const isContactPointRequired = (endpoint, message) =>
  Boolean(endpoint) &&
  endpoint.includes('accounts/edit_profile') &&
  CONTACT_POINT_MARKERS.some((marker) => messageText(message).toLowerCase().includes(marker))

const isAccountEditError = (endpoint) => Boolean(endpoint) && endpoint.includes('accounts/edit_profile')

const isDirectDisabled = (endpoint, message) => {
  if (!endpoint || !message || !endpoint.includes('direct_v2/')) return false
  const normalized = messageText(message).toLowerCase().replace(/\u2019/g, "'")
  return DM_DISABLED_MARKERS.some((marker) => normalized.includes(marker))
}

const exceptionContext = (json) => {
  const { message, ...rest } = json
  return rest
}

export const manualInputCode = async () => {
  throw new ChallengeRequired(
    'Challenge code input is unavailable. Provide challengeCodeHandler or set withChallengeFlow to false.'
  )
}

export const privateMixin = {
  smallDelay() {
    return sleep(randomUniform(0.75, 3.75) * 1000)
  },

  verySmallDelay() {
    return sleep(randomUniform(0.175, 0.875) * 1000)
  },

  get baseHeaders() {
    const locale = this.locale.replace('-', '_')
    const acceptLanguage = ['en-US']
    if (locale) {
      const lang = locale.replace('_', '-')
      if (!acceptLanguage.includes(lang)) acceptLanguage.unshift(lang)
    }
    const nowSeconds = Date.now() / 1000
    const headers = {
      'X-IG-App-Locale': locale,
      'X-IG-Device-Locale': locale,
      'X-IG-Mapped-Locale': locale,
      'X-Pigeon-Session-Id': this.pigeonSessionId,
      'X-Pigeon-Rawclienttime': nowSeconds.toFixed(3),
      'X-IG-Bandwidth-Speed-KBPS': '-1.000',
      'X-IG-Bandwidth-TotalBytes-B': '0',
      'X-IG-Bandwidth-TotalTime-MS': '0',
      'X-IG-App-Startup-Country': this.country.toUpperCase(),
      'X-Bloks-Version-Id': this.bloksVersioningId,
      'X-IG-WWW-Claim': '0',
      'X-Bloks-Is-Layout-RTL': 'false',
      'X-Bloks-Is-Panorama-Enabled': 'true',
      'X-IG-Device-ID': this.uuid,
      'X-IG-Family-Device-ID': this.phoneId,
      'X-IG-Android-ID': this.androidDeviceId,
      'X-IG-Timezone-Offset': String(this.timezoneOffset),
      'X-IG-Connection-Type': 'WIFI',
      'X-IG-Capabilities': '3brTv10=',
      'X-IG-App-ID': this.appId,
      Priority: 'u=3',
      'User-Agent': this.userAgent,
      'Accept-Language': acceptLanguage.join(', '),
      'X-MID': this.mid,
      Host: this.domain,
      'X-FB-HTTP-Engine': 'Tigon/MNS/TCP',
      'X-Tigon-Is-Retry': 'False',
      'X-Zero-Balance': 'INIT',
      'X-Zero-Eh': '',
      'X-Zero-State': 'unknown',
      'Zero-HTTP-Network-Interface': 'wifi',
      Connection: 'keep-alive',
      'X-FB-Client-IP': 'True',
      'X-FB-Server-Cluster': 'True',
      'IG-INTENDED-USER-ID': String(this.userId || 0),
      'X-IG-Nav-Chain': '9MV:self_profile:2,ProfileMediaTabFragment:self_profile:3,9Xf:self_following:4'
    }
    if (this.userId) {
      const nextYear = Math.floor(nowSeconds + 31536000)
      Object.assign(headers, {
        'IG-U-DS-USER-ID': String(this.userId),
        'IG-U-IG-DIRECT-REGION-HINT': `LLA,${this.userId},${nextYear}:01f7bae7d8b131877d8e0ae1493252280d72f6d0d554447cb1dc9049b6b2c507c08605b7`,
        'IG-U-SHBID': `12695,${this.userId},${nextYear}:01f778d9c9f7546cf3722578fbf9b85143cd6e5132723e5c93f40f55ca0459c8ef8a0d9f`,
        'IG-U-SHBTS': `${Math.floor(nowSeconds)},${this.userId},${nextYear}:01f7ace11925d0388080078d0282b75b8059844855da27e23c90a362270fddfb3fae7e28`,
        'IG-U-RUR': `RVA,${this.userId},${nextYear}:01f7f627f9ae4ce2874b2e04463efdb184340968b1b006fa88cb4cc69a942a04201e544c`
      })
    }
    if (this.igURur) headers['IG-U-RUR'] = this.igURur
    if (this.igWwwClaim) headers['X-IG-WWW-Claim'] = this.igWwwClaim
    return headers
  },

  setCountry(country = 'US') {
    this.settings.country = this.country = String(country)
    return true
  },

  setCountryCode(countryCode = 1) {
    this.settings.country_code = this.countryCode = Number(countryCode)
    return true
  },

  setLocale(locale = 'en_US') {
    const userAgent = (this.settings.user_agent || '').replace(this.locale, locale)
    this.settings.locale = this.locale = String(locale)
    this.setUserAgent(userAgent)
    if (locale.includes('_')) this.setCountry(locale.split('_').at(-1))
    return true
  },

  timezoneNameFromOffset(seconds) {
    const value = Number(seconds)
    if (value === 0) return 'GMT'
    const sign = value > 0 ? '+' : '-'
    const abs = Math.abs(value)
    const hours = Math.floor(abs / 3600)
    const minutes = Math.floor((abs % 3600) / 60)
    return `GMT${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
  },

  boolToIgString(value) {
    return value ? 'true' : 'false'
  },

  setTimezoneName(timezoneName = '') {
    this.settings.timezone_name = this.timezoneName = String(timezoneName)
    return true
  },

  setTimezoneOffset(seconds = 0, timezoneName = null) {
    this.settings.timezone_offset = this.timezoneOffset = Number(seconds)
    this.setTimezoneName(
      timezoneName === null ? this.timezoneNameFromOffset(this.timezoneOffset) : timezoneName
    )
    return true
  },

  setPushDisabled(disabled = true) {
    this.settings.push_disabled = this.pushDisabled = Boolean(disabled)
    return true
  },

  setIgURur(value) {
    this.settings.ig_u_rur = this.igURur = value
    return true
  },

  setIgWwwClaim(value) {
    this.settings.ig_www_claim = this.igWwwClaim = value
    return true
  },

  withQueryParams(data, params) {
    return { ...data, query_params: JSON.stringify(params) }
  },

  requestLog(response) {
    this.privateRequestLogger.info(
      `${this.username} [${response.status}] ${response.method} ${response.url} (${this.deviceSettings.app_version}, ${this.deviceSettings.manufacturer} ${this.deviceSettings.model})`
    )
  },

  async sendPrivateRequest(endpoint, data = null, opts = {}) {
    const {
      params = null,
      login = false,
      withSignature = true,
      headers = null,
      extraSig = null,
      domain = null,
      returnResponse = false
    } = opts
    this.lastResponse = null
    this.lastJson = {}
    const requestHeaders = { ...this.baseHeaders, ...(headers ?? {}) }
    if (domain) requestHeaders.Host = domain
    if (!login) await sleep(this.requestTimeout * 1000)
    let path = endpoint
    if (!path.startsWith('/')) path = `/v1/${path}`
    if (path === '/challenge/') path = '/v1/challenge/'
    const apiUrl = `https://${domain || API_DOMAIN}/api${path}`
    this.logger.info(apiUrl)

    let response
    try {
      let body = null
      let method = 'GET'
      if (data) {
        method = 'POST'
        requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
        if (typeof data === 'string') {
          body = withSignature ? generateSignature(dumps(data)) : data
          if (withSignature && extraSig) body += extraSig.join('&')
        } else if (withSignature) {
          body = generateSignature(dumps(data))
          if (extraSig) body += extraSig.join('&')
        } else {
          body = encodeForm(data)
        }
      }
      response = await this.private.request(method, apiUrl, {
        headers: requestHeaders,
        body,
        params,
        timeout: this.readTimeout * 1000
      })
    } catch (error) {
      const code = error?.cause?.code ?? ''
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new ClientConnectionError(`${error.name} ${error.message}`)
      }
      if (code === 'UND_ERR_SOCKET' || /terminated|incomplete/i.test(String(error?.message))) {
        throw new ClientIncompleteReadError(`${error.name} ${error.message}`)
      }
      throw new ClientConnectionError(`${error?.name ?? 'Error'} ${error?.message ?? error}`)
    }

    this.logger.debug(`private_request ${response.status}: ${response.url} (${response.text})`)
    const mid = response.headers.get('ig-set-x-mid')
    if (mid) this.mid = mid
    this.requestLog(response)
    this.lastResponse = response
    if (returnResponse) return response

    if (!response.ok) {
      let lastJson = {}
      try {
        lastJson = response.json()
      } catch {
        lastJson = {}
      }
      this.lastJson = lastJson
      this.throwHttpError(response, endpoint, lastJson)
    }

    let lastJson
    try {
      lastJson = response.json()
    } catch (error) {
      this.logger.error(
        `Status ${response.status}: JSONDecodeError in private_request (user_id=${this.userId}, endpoint=${endpoint}) >>> ${response.text.slice(0, 200)}`
      )
      throw new ClientJSONDecodeError(`JSONDecodeError ${error.message} while opening ${response.url}`, {
        response
      })
    }
    this.lastJson = lastJson
    this.logger.debug(`last_json ${JSON.stringify(lastJson)}`)

    if (lastJson.status === 'fail') {
      const message = lastJson.message ?? ''
      if (isContactPointRequired(endpoint, message)) throw new AccountContactPointRequired('', { response, ...lastJson })
      if (isAccountEditError(endpoint)) throw new AccountEditError('', { response, ...lastJson })
      if (isDirectDisabled(endpoint, message)) throw new DirectMessageRequestsDisabled('', { response, ...lastJson })
      throw new ClientError('', { response, ...lastJson })
    }
    if ('error_title' in lastJson) throw new ClientError('', { response, ...lastJson })
    return lastJson
  },

  throwHttpError(response, endpoint, lastJson) {
    const status = response.status
    const rawMessage = lastJson.message ?? ''
    const message = typeof rawMessage === 'string' ? rawMessage : messageText(rawMessage)
    const label = `HTTP ${status}`
    const withResponse = { response, ...lastJson }

    if (message.includes('Please wait a few minutes')) throw new PleaseWaitFewMinutes(label, withResponse)

    if (status === 403) {
      if (message === 'login_required') throw new LoginRequired('', withResponse)
      const extra = response.text.length < 512 ? { message: response.text } : {}
      throw new ClientForbiddenError(label, { ...withResponse, ...extra })
    }

    if (status === 400) {
      const errorType = lastJson.error_type
      if (lastJson.two_factor_info) {
        const json = { ...lastJson }
        if (!json.message) {
          json.message = 'Two-factor authentication required'
          json.error_type = 'two_factor_required'
        }
        throw new TwoFactorRequired('', { response, ...json })
      }
      if (message === 'challenge_required') {
        if ((lastJson.challenge?.url ?? '').includes('/suspended/')) throw new AccountSuspended('', withResponse)
        throw new ChallengeRequired('', withResponse)
      }
      if (message === 'feedback_required') {
        throw new FeedbackRequired('', {
          ...withResponse,
          message: `${message}: ${lastJson.feedback_message}`
        })
      }
      if (errorType === 'sentry_block') throw new SentryBlock('', withResponse)
      if (errorType === 'rate_limit_error') throw new RateLimitError('', withResponse)
      if (errorType === 'bad_password') {
        throw new BadPassword('', {
          ...withResponse,
          message: [message || 'Instagram rejected the login credentials.', LOGIN_CONTEXT_HINT]
            .filter(Boolean)
            .join(' ')
        })
      }
      if (errorType === 'two_factor_required') {
        throw new TwoFactorRequired('', {
          ...withResponse,
          message: message || 'Two-factor authentication required'
        })
      }
      if (isContactPointRequired(endpoint, message)) throw new AccountContactPointRequired(label, withResponse)
      if (isAccountEditError(endpoint)) throw new AccountEditError(label, withResponse)
      if (isDirectDisabled(endpoint, message)) throw new DirectMessageRequestsDisabled(label, withResponse)
      if (message.includes('VideoTooLongException')) throw new VideoTooLongException(label, withResponse)
      if (message.includes('Not authorized to view user')) throw new PrivateAccount(label, withResponse)
      if (message.includes('Invalid target user')) throw new InvalidTargetUser(label, withResponse)
      if (message.includes('Invalid media_id')) throw new InvalidMediaId(label, withResponse)
      if (message.includes('Media is unavailable') || message.includes('Media not found or unavailable')) {
        throw new MediaUnavailable(label, withResponse)
      }
      if (message.includes('has been deleted')) throw new MediaUnavailable(label, withResponse)
      if (message.includes('unable to fetch followers')) throw new UserNotFound(label, withResponse)
      if (message.includes('The username you entered')) {
        throw new ProxyAddressIsBlocked('', {
          ...withResponse,
          message: 'Instagram has blocked your IP address, use a quality proxy provider (not free, not shared)'
        })
      }
      if (errorType === 'needs_upgrade') throw new ClientNeedsUpgradeError('', withResponse)
      if (errorType || message) throw new UnknownError('', withResponse)
      this.logger.warn(`Status 400: ${message || 'Empty response message. Maybe enabled Two-factor auth?'}`)
      throw new ClientBadRequestError(label, withResponse)
    }

    if (status === 429) {
      this.logger.warn('Status 429: Too many requests')
      throw new ClientThrottledError(label, withResponse)
    }
    if (status === 401) {
      this.logger.warn(`Status 401: Unauthorized ${endpoint}`)
      throw new ClientUnauthorizedError(label, withResponse)
    }
    if (status === 404) {
      if (response.text === 'Not Found') {
        this.logger.warn(`Status 404 (masked challenge): ${endpoint}`)
        throw new ChallengeRequired('', { response, ...exceptionContext(lastJson) })
      }
      this.logger.warn(`Status 404: Endpoint ${endpoint} does not exist`)
      throw new ClientNotFoundError(label, withResponse)
    }
    if (status === 408) {
      this.logger.warn('Status 408: Request Timeout')
      throw new ClientRequestTimeout(label, withResponse)
    }
    throw new ClientError(label, withResponse)
  },

  async privateRequest(endpoint, data = null, opts = {}) {
    const options = { ...opts, headers: { ...(opts.headers ?? {}) } }
    if (this.authorization && !('Authorization' in options.headers) && !('authorization' in options.headers)) {
      options.headers.Authorization = this.authorization
    }
    try {
      if (this.delayRange) await randomDelay(this.delayRange)
      this.privateRequestsCount += 1
      await this.sendPrivateRequest(endpoint, data, options)
    } catch (error) {
      if (error instanceof ClientRequestTimeout) {
        this.logger.info('Wait 60 seconds and try one more time (ClientRequestTimeout)')
        await sleep(60000)
        return this.sendPrivateRequest(endpoint, data, options)
      }
      if (error instanceof ClientIncompleteReadError) {
        this.logger.info('Wait 2 seconds and try one more time (ClientIncompleteReadError)')
        await sleep(2000)
        return this.sendPrivateRequest(endpoint, data, options)
      }
      if (this.handleException) {
        await this.handleException(this, error)
      } else if (error instanceof ChallengeRequired && this.withChallengeFlow && this.challengeResolve) {
        await this.challengeResolve(this.lastJson)
      } else {
        throw error
      }
      if (options.login && this.userId) return this.lastJson
      return this.sendPrivateRequest(endpoint, data, options)
    }
    return this.lastJson
  }
}
