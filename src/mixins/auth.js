import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import {
  APP_KEYS,
  APP_SETTINGS,
  DEFAULT_APP_VERSION,
  DEVICE_SETTINGS,
  SUPPORTED_CAPABILITIES,
  formatUserAgent
} from '../config.js'
import {
  BadCredentials,
  ClientThrottledError,
  LoginRequired,
  PleaseWaitFewMinutes,
  ReloginAttemptExceeded,
  TwoFactorRequired
} from '../errors.js'
import { dumps, generateJazoest, genToken, generateUuid, randomBetween } from '../utils.js'

const usdidSettingsEntry = (client) => {
  const usdidSettings = client.getUsdidSettings()
  return Object.keys(usdidSettings).length ? { usdid: usdidSettings } : {}
}

export const authMixin = {
  get cookieDict() {
    return this.private.cookies.toObject()
  },

  get sessionid() {
    return this.cookieDict.sessionid || this.authorizationData?.sessionid || null
  },

  get token() {
    if (!this._token) this._token = this.cookieDict.csrftoken || genToken(64)
    return this._token
  },

  get rankToken() {
    return `${this.userId}_${this.uuid}`
  },

  get userId() {
    const userId = this.cookieDict.ds_user_id || this.authorizationData?.ds_user_id
    return userId ? Number(userId) : null
  },

  get device() {
    const keys = ['manufacturer', 'model', 'android_version', 'android_release']
    return Object.fromEntries(Object.entries(this.deviceSettings).filter(([key]) => keys.includes(key)))
  },

  get authorization() {
    if (this.authorizationData && Object.keys(this.authorizationData).length) {
      const b64 = Buffer.from(dumps(this.authorizationData)).toString('base64')
      return `Bearer IGT:2:${b64}`
    }
    return ''
  },

  parseAuthorization(authorization) {
    if (!authorization) return {}
    try {
      const b64 = authorization.split(':').at(-1)
      if (!b64) return {}
      return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    } catch (error) {
      this.logger.error(error)
      return {}
    }
  },

  clearSessionState({
    clearPrivateCookies = false,
    clearAuthorizationData = false,
    clearLastLogin = false,
    resetReloginAttempt = false
  } = {}) {
    if (clearAuthorizationData) {
      this.authorizationData = {}
      this.setIgURur('')
      this.setIgWwwClaim('')
    }
    if (clearLastLogin) this.lastLogin = null
    if (resetReloginAttempt) this.reloginAttempt = 0
    if (clearPrivateCookies) this.private.cookies.clear()
  },

  init() {
    if (this.settings.cookies) {
      this.private.cookies.clear()
      for (const [name, value] of Object.entries(this.settings.cookies)) this.private.cookies.set(name, value)
    } else {
      this.clearSessionState({ clearPrivateCookies: true })
    }
    this.authorizationData = this.settings.authorization_data ?? {}
    this.lastLogin = this.settings.last_login ?? null
    const timezoneOffset = this.settings.timezone_offset ?? this.timezoneOffset
    const timezoneName = this.settings.timezone_name ?? this.timezoneName
    const pushDisabled = this.settings.push_disabled ?? this.pushDisabled
    const locale = this.settings.locale ?? this.locale
    const country = this.settings.country ?? this.country
    const countryCode = this.settings.country_code ?? this.countryCode
    this.setTlsVerify(this.settings.tls_verify ?? this.tlsVerify)
    this.requestTimeout = this.settings.request_timeout ?? this.requestTimeout
    this.setTimezoneOffset(timezoneOffset, timezoneName || null)
    this.setPushDisabled(pushDisabled)
    this.setDevice(this.settings.device_settings, { hydrateAppProfile: true })
    this.setUserAgent(this.settings.user_agent)
    this.setUuids(this.settings.uuids ?? {})
    this.setLocale(locale)
    this.setCountry(country)
    this.setCountryCode(countryCode)
    this.mid = this.settings.mid ?? this.cookieDict.mid ?? ''
    this.setIgURur(this.settings.ig_u_rur ?? '')
    this.setIgWwwClaim(this.settings.ig_www_claim ?? '')
    this.setUsdidSettings(this.settings.usdid)
    return true
  },

  setTlsVerify(tlsVerify) {
    this.tlsVerify = tlsVerify
    this.private.setVerify(tlsVerify)
    return true
  },

  getSettings() {
    return {
      uuids: {
        phone_id: this.phoneId,
        uuid: this.uuid,
        client_session_id: this.clientSessionId,
        advertising_id: this.advertisingId,
        android_device_id: this.androidDeviceId,
        request_id: this.requestId,
        tray_session_id: this.traySessionId
      },
      mid: this.mid,
      ig_u_rur: this.igURur,
      ig_www_claim: this.igWwwClaim,
      authorization_data: this.authorizationData,
      cookies: this.private.cookies.toObject(),
      last_login: this.lastLogin,
      device_settings: this.deviceSettings,
      user_agent: this.userAgent,
      country: this.country,
      country_code: this.countryCode,
      locale: this.locale,
      timezone_offset: this.timezoneOffset,
      timezone_name: this.timezoneName,
      push_disabled: this.pushDisabled,
      request_timeout: this.requestTimeout,
      tls_verify: this.tlsVerify,
      ...usdidSettingsEntry(this)
    }
  },


  setSettings(settings) {
    this.settings = structuredClone(settings)
    this.init()
    return true
  },

  async loadSettings(path, { overrideAppVersion = false } = {}) {
    this.overrideAppVersion = overrideAppVersion
    this.setSettings(JSON.parse(await readFile(path, 'utf8')))
    return this.settings
  },

  async dumpSettings(path) {
    await writeFile(path, JSON.stringify(this.getSettings(), null, 4))
    return true
  },

  setDevice(device = null, { reset = false, hydrateAppProfile = false } = {}) {
    this.deviceSettings = { ...DEVICE_SETTINGS, ...(device ?? {}) }
    const seed = this.settings?.uuids?.uuid ?? null
    this.setApp(null, { seed, hydrateIncompleteProfile: hydrateAppProfile })
    this.setUserAgent()
    if (reset) this.setUuids({})
    return true
  },

  setApp(app = null, { seed = null, hydrateIncompleteProfile = false } = {}) {
    if (!this.deviceSettings || !Object.keys(this.deviceSettings).length) {
      this.deviceSettings = { ...DEVICE_SETTINGS }
    }
    const override = Boolean(this.overrideAppVersion)
    const applySettings = (appSettings) => {
      for (const key of APP_KEYS) {
        if (appSettings[key]) this.deviceSettings[key] = appSettings[key]
      }
    }
    const pickBySeed = () => {
      const values = Object.values(APP_SETTINGS)
      if (seed) {
        const digest = BigInt(`0x${createHash('sha256').update(seed).digest('hex')}`)
        return values[Number(digest % BigInt(values.length))]
      }
      return values[randomBetween(0, values.length - 1)]
    }
    const defaultSettings = () => APP_SETTINGS[DEFAULT_APP_VERSION] ?? pickBySeed()
    const isCurrentOrNewer = (value) => {
      const version = String(value).split('.').map(Number)
      const current = DEFAULT_APP_VERSION.split('.').map(Number)
      if (version.some(Number.isNaN)) return false
      for (let i = 0; i < Math.max(version.length, current.length); i += 1) {
        const a = version[i] ?? 0
        const b = current[i] ?? 0
        if (a !== b) return a > b
      }
      return true
    }

    if (app) {
      if (typeof app === 'string') {
        const matched = APP_SETTINGS[app]
        if (!matched) throw new Error(`Unknown app_version: ${app}`)
        applySettings(matched)
      } else {
        applySettings(app)
      }
    } else {
      const appVersion = this.deviceSettings.app_version
      const matched = appVersion ? APP_SETTINGS[appVersion] : null
      if (matched && !override) {
        applySettings(matched)
      } else {
        const complete = APP_KEYS.every((key) => this.deviceSettings[key])
        const hydrate = hydrateIncompleteProfile && !complete && isCurrentOrNewer(appVersion)
        if (override || !appVersion || hydrate) applySettings(defaultSettings())
      }
    }
    if (override) this.setUserAgent()
    this.bloksVersioningId = this.deviceSettings.bloks_versioning_id
    if (this.settings) this.settings.device_settings = this.deviceSettings
    return true
  },

  setUserAgent(userAgent = '', { reset = false } = {}) {
    const data = { ...this.deviceSettings, locale: this.locale }
    this.userAgent = userAgent || formatUserAgent(data)
    this.settings.user_agent = this.userAgent
    if (reset) this.setUuids({})
    return true
  },

  setUuids(uuids = {}) {
    const previousPhoneId = this.phoneId
    this.phoneId = uuids.phone_id ?? this.generateUuid()
    this.uuid = uuids.uuid ?? this.generateUuid()
    this.clientSessionId = uuids.client_session_id ?? this.generateUuid()
    this.advertisingId = uuids.advertising_id ?? this.generateUuid()
    this.androidDeviceId = uuids.android_device_id ?? this.generateAndroidDeviceId()
    this.requestId = uuids.request_id ?? this.generateUuid()
    this.traySessionId = uuids.tray_session_id ?? this.generateUuid()
    this.settings.uuids = uuids
    if (previousPhoneId && previousPhoneId !== this.phoneId) this.setUsdidSettings({})
    return true
  },

  generateUuid(prefix = '', suffix = '') {
    return generateUuid(prefix, suffix)
  },

  generateMutationToken() {
    const min = 6800011111111111111n
    const span = 6800099999999999999n - min + 1n
    const rand = BigInt(`0x${randomBytes(8).toString('hex')}`)
    return String(min + (rand % span))
  },

  generateAndroidDeviceId() {
    const digest = createHash('sha256')
      .update(String(Date.now() / 1000))
      .digest('hex')
    return `android-${digest.slice(0, 16)}`
  },

  withDefaultData(data) {
    return { _uuid: this.uuid, device_id: this.androidDeviceId, ...data }
  },

  withExtraData(data) {
    return this.withDefaultData({
      phone_id: this.phoneId,
      _uid: String(this.userId),
      guid: this.uuid,
      ...data
    })
  },

  withActionData(data) {
    return { ...this.withDefaultData({ radio_type: 'wifi-none' }), ...data }
  },

  genUserBreadcrumb(size) {
    const key = 'iN4$aGr0m'
    const dt = Date.now()
    const timeElapsed = randomBetween(500, 1500) + size * randomBetween(500, 1500)
    const textChangeEventCount = Math.max(1, size / randomBetween(3, 5))
    const data = `${size} ${timeElapsed} ${textChangeEventCount} ${dt}`
    const signature = createHmac('sha256', key).update(data).digest('base64')
    return `${signature}\n${Buffer.from(data).toString('base64')}\n`
  },

  async preLoginFlow() {
    await this.syncLauncher(true)
    return true
  },

  async syncLauncher(login = false) {
    const data = { id: this.uuid, server_config_retrieval: '1' }
    if (!login) {
      data._uid = this.userId
      data._uuid = this.uuid
      data._csrftoken = this.token
    }
    return this.privateRequest('launcher/sync/', data, { login })
  },

  async syncDeviceFeatures(login = false) {
    const data = { id: this.uuid, server_config_retrieval: '1' }
    if (!login) {
      data._uuid = this.uuid
      data._uid = this.userId
      data._csrftoken = this.token
    }
    return this.privateRequest('qe/sync/', data, { login })
  },

  async getPrefillCandidates(login = false) {
    const data = {
      android_device_id: this.androidDeviceId,
      client_contact_points: `[{"type":"omnistring","value":"${this.username}","source":"last_login_attempt"}]`,
      phone_id: this.phoneId,
      usages: '["account_recovery_omnibox"]',
      logged_in_user_ids: '[]',
      device_id: this.uuid,
      _csrftoken: this.token
    }
    return this.privateRequest('accounts/get_prefill_candidates/', data, { login })
  },

  async setContactPointPrefill(usage = 'prefill') {
    return this.privateRequest(
      'accounts/contact_point_prefill/',
      { phone_id: this.phoneId, usage },
      { login: true }
    )
  },

  async loginFlow() {
    const checks = []
    checks.push(await this.getReelsTrayFeed('cold_start'))
    checks.push(await this.getTimelineFeed(['cold_start_fetch']))
    return checks.every(Boolean)
  },

  timelineMediaId(media) {
    const mediaId = media.id ?? media.media_id
    if (mediaId) return String(mediaId)
    const pk = media.pk
    const userPk = media.user?.pk ?? media.user_id ?? media.owner_id
    if (pk && userPk) return `${pk}_${userPk}`
    return pk ? String(pk) : ''
  },

  rememberTimelineSeenPosts(response) {
    const remembered = [...(this.timelineSeenPosts ?? [])]
    const known = new Set(remembered)
    for (const item of response.feed_items ?? []) {
      const media = item?.media_or_ad ?? item?.media
      if (!media || typeof media !== 'object') continue
      const mediaId = this.timelineMediaId(media)
      if (mediaId && !known.has(mediaId)) {
        remembered.push(mediaId)
        known.add(mediaId)
      }
    }
    this.timelineSeenPosts = remembered.slice(-200)
  },

  timelineFeedViewInfoJson(feedViewInfo, seenPosts) {
    if (feedViewInfo !== null && feedViewInfo !== undefined) {
      return typeof feedViewInfo === 'string' ? feedViewInfo : JSON.stringify(feedViewInfo)
    }
    if (!seenPosts) return '[]'
    const latestTimestamp = Date.now()
    return JSON.stringify(
      seenPosts.split(',').map((mediaId) => ({
        media_id: String(mediaId),
        version: 24,
        media_pct: 1.0,
        time_info: { 10: 1, 25: 1, 50: 1, 75: 1 },
        latest_timestamp: latestTimestamp
      }))
    )
  },

  timelineSessionLevelSignalsJson() {
    const inactive = -1
    return dumps({
      time_since_current_surface_session_start: 0,
      time_since_fg_session_start: 0,
      time_since_last_background: 0,
      num_ad_seen_current_surface_current_session: 0,
      app_entry: 'normal',
      last_surfaces_visited_current_session: [],
      video_play_count: 0,
      video_pause_count: 0,
      video_dwell_time_sum: 0,
      video_dwell_time_max: 0,
      video_view_count: 0,
      video_intentional_audio_on: 0,
      video_intentional_audio_off: 0,
      video_audio_on_count: 0,
      feed_to_reels_iv_entry: 0,
      time_since_last_ad_click: inactive,
      time_since_last_ad_like: inactive,
      time_since_last_organic_like: inactive,
      time_since_last_like: inactive,
      time_since_last_organic_business_profile_visit: inactive,
      time_since_last_ad_imp: inactive,
      time_since_last_search: inactive,
      time_since_last_organic_engagement_event: inactive,
      time_since_last_ad_profile_visit: inactive,
      time_since_last_ad_cta: inactive,
      time_since_last_ad_caption_more_click: inactive,
      time_since_last_ad_comment_button: inactive,
      time_since_last_ad_share: inactive,
      time_since_last_ad_media_tap: inactive,
      time_since_last_ad_gesture: inactive,
      time_since_last_search_result_click: inactive,
      time_since_last_serp_click: inactive,
      time_since_last_organic_share: inactive,
      time_since_last_organic_comment: inactive,
      time_since_last_organic_caption_click: inactive,
      time_since_last_organic_media_tap: inactive,
      time_since_last_organic_gesture: inactive,
      num_search_clicks_current_session: 0
    })
  },

  async getTimelineFeed(reason = 'pull_to_refresh', { maxId = null, seenPosts = null, feedViewInfo = null } = {}) {
    const reasonValue = Array.isArray(reason) ? reason[0] : reason
    const headers = {
      'X-Ads-Opt-Out': '0',
      'X-DEVICE-ID': this.uuid,
      'X-CM-Bandwidth-KBPS': '-1.000',
      'X-CM-Latency': String(randomBetween(1, 5))
    }
    const requestTimeMs = String(Date.now())
    const data = {
      app_start_time: requestTimeMs,
      has_camera_permission: '1',
      feed_view_info: '[]',
      client_recorded_request_time_ms: requestTimeMs,
      client_seen_store_media_list: '',
      client_view_state_media_list: '[]',
      device_timezone_name: this.timezoneName,
      feed_reshare_info: '',
      phone_id: this.phoneId,
      reason: reasonValue,
      battery_level: 100,
      timezone_offset: String(this.timezoneOffset),
      device_id: this.uuid,
      include_attribution_ui_data: 'true',
      push_disabled: this.boolToIgString(this.pushDisabled),
      request_id: this.requestId,
      request_build_time: requestTimeMs,
      _uuid: this.uuid,
      is_charging: randomBetween(0, 1),
      is_dark_mode: 1,
      will_sound_on: randomBetween(0, 1),
      session_id: this.clientSessionId,
      session_level_signals: this.timelineSessionLevelSignalsJson(),
      bloks_versioning_id: this.bloksVersioningId
    }
    data.is_pull_to_refresh = ['pull_to_refresh', 'auto_refresh'].includes(reasonValue) ? '1' : '0'
    let seen = seenPosts
    if (maxId) {
      data.max_id = maxId
      data.reason = 'pagination'
      data.organic_realtime_information = '[]'
      data.pagination_source = 'feed_recs'
      data.triggered_by_visible_spinner = 'false'
      if (seen === null) seen = this.timelineSeenPosts ?? []
    }
    const seenValue = !seen ? '' : typeof seen === 'string' ? seen : [...seen].filter(Boolean).join(',')
    if (seenValue) data.seen_posts = seenValue
    data.feed_view_info = this.timelineFeedViewInfoJson(feedViewInfo, seenValue)
    const result = await this.privateRequest('feed/timeline/', JSON.stringify(data), {
      withSignature: false,
      headers
    })
    this.rememberTimelineSeenPosts(result)
    return result
  },

  async getReelsTrayFeed(reason = 'pull_to_refresh') {
    const data = {
      supported_capabilities_new: SUPPORTED_CAPABILITIES,
      reason,
      timezone_offset: String(this.timezoneOffset),
      tray_session_id: this.traySessionId,
      request_id: this.requestId,
      page_size: 50,
      _uuid: this.uuid
    }
    data.reel_tray_impressions = reason === 'cold_start' ? {} : { [this.userId]: String(Date.now() / 1000) }
    return this.privateRequest('feed/reels_tray/', data)
  },

  async loginBySessionid(sessionid) {
    if (typeof sessionid !== 'string' || sessionid.length <= 30) throw new Error('Invalid sessionid')
    const match = sessionid.match(/^\d+/)
    if (!match) throw new Error('Invalid sessionid')
    this.settings.cookies = { sessionid }
    this.init()
    const userId = match[0]
    this.authorizationData = {
      ds_user_id: userId,
      sessionid,
      should_use_header_over_cookies: true
    }
    const user = await this.userInfoV1(userId)
    this.username = user.username
    this.authorizationData.ds_user_id = String(user.pk)
    this.private.cookies.set('ds_user_id', String(user.pk))
    return true
  },

  async login(username = null, password = null, { relogin = false, verificationCode = '' } = {}) {
    if (username && password) {
      this.username = username
      this.password = password
    }
    if (this.username === null || this.password === null) {
      throw new BadCredentials('Both username and password must be provided.')
    }
    if (typeof this.username === 'string') this.username = this.username.trim()

    if (relogin) {
      this.clearSessionState({ clearAuthorizationData: true, clearPrivateCookies: true })
      if (this.reloginAttempt > 1) throw new ReloginAttemptExceeded()
      this.reloginAttempt += 1
    }
    if (this.userId && !relogin) {
      try {
        await this.accountInfo()
      } catch (error) {
        if (error instanceof LoginRequired) return this.login(null, null, { relogin: true, verificationCode })
        throw error
      }
      return true
    }

    try {
      await this.preLoginFlow()
    } catch (error) {
      if (!(error instanceof PleaseWaitFewMinutes || error instanceof ClientThrottledError)) throw error
      this.logger.warn('Ignore 429: Continue login')
    }

    const encPassword = await this.passwordEncrypt(this.password)
    const data = {
      jazoest: generateJazoest(this.phoneId),
      country_codes: `[{"country_code":"${Number(this.countryCode)}","source":["default"]}]`,
      phone_id: this.phoneId,
      enc_password: encPassword,
      username: this.username,
      adid: this.advertisingId,
      guid: this.uuid,
      device_id: this.androidDeviceId,
      google_tokens: '[]',
      login_attempt_count: '0'
    }

    let logged = false
    try {
      logged = await this.privateRequest('accounts/login/', data, { login: true })
      this.authorizationData = this.parseAuthorization(this.lastResponse.headers.get('ig-set-authorization'))
    } catch (error) {
      if (error instanceof TwoFactorRequired) {
        if (!verificationCode.trim()) {
          throw new TwoFactorRequired(
            `${error.message} (you did not provide verificationCode for login method)`,
            { response: error.response }
          )
        }
        const identifier = this.lastJson?.two_factor_info?.two_factor_identifier
        const twoFactorData = {
          verification_code: verificationCode,
          phone_id: this.phoneId,
          _csrftoken: this.token,
          two_factor_identifier: identifier,
          username: this.username,
          trust_this_device: '0',
          guid: this.uuid,
          device_id: this.androidDeviceId,
          waterfall_id: randomUUID(),
          verification_method: '3'
        }
        logged = await this.privateRequest('accounts/two_factor_login/', twoFactorData, { login: true })
        this.authorizationData = this.parseAuthorization(this.lastResponse.headers.get('ig-set-authorization'))
      } else {
        throw error
      }
    }

    if (logged) {
      await this.loginFlow()
      this.lastLogin = Date.now() / 1000
      this.reloginAttempt = 0
      return true
    }
    return false
  },

  async relogin() {
    return this.login(this.username, this.password, { relogin: true })
  },

  async logout() {
    const result = await this.privateRequest('accounts/logout/', { one_tap_app_login: true })
    if (result.status === 'ok') {
      this.clearSessionState({
        clearAuthorizationData: true,
        clearLastLogin: true,
        resetReloginAttempt: true,
        clearPrivateCookies: true
      })
      return true
    }
    return false
  },

  async expose() {
    return this.privateRequest(
      'qe/expose/',
      this.withDefaultData({ id: this.uuid, experiment: 'ig_android_profile_contextual_feed' })
    )
  }
}
