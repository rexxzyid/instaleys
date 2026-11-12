import { API_DOMAIN, DEFAULT_APP_VERSION, APP_SETTINGS } from './config.js'
import { HttpSession } from './http.js'
import { generateUuid } from './utils.js'
import { manualInputCode, privateMixin } from './mixins/private.js'
import { authMixin } from './mixins/auth.js'
import { passwordMixin } from './mixins/password.js'
import { accountMixin } from './mixins/account.js'
import { userMixin } from './mixins/user.js'
import { mediaMixin } from './mixins/media.js'
import { commentMixin } from './mixins/comment.js'
import { directMixin } from './mixins/direct.js'
import { directExtraMixin } from './mixins/direct_extra.js'
import { storyMixin } from './mixins/story.js'
import { hashtagMixin } from './mixins/hashtag.js'
import { exploreMixin } from './mixins/explore.js'
import { totpMixin } from './mixins/totp.js'
import { shareMixin } from './mixins/share.js'
import { collectionMixin } from './mixins/collection.js'
import { timelineMixin } from './mixins/timeline.js'
import { locationMixin } from './mixins/location.js'
import { highlightMixin } from './mixins/highlight.js'

const silent = () => {}

export const defaultLogger = {
  debug: process.env.INSTAGRAPI_DEBUG ? console.debug : silent,
  info: process.env.INSTAGRAPI_DEBUG ? console.info : silent,
  warn: console.warn,
  error: console.error
}

export class Client {
  constructor({
    settings = null,
    proxy = null,
    delayRange = null,
    logger = defaultLogger,
    overrideAppVersion = false,
    tlsVerify = true,
    requestTimeout = 1,
    readTimeout = 25,
    timezoneOffset = -14400,
    timezoneName = '',
    pushDisabled = true,
    withChallengeFlow = true,
    challengeCodeHandler = manualInputCode,
    handleException = null
  } = {}) {
    this.usersCache = new Map()
    this.usernamesCache = new Map()
    this.mediasCache = new Map()
    this.storiesCache = new Map()
    this.privateRequestsCount = 0
    this.lastResponse = null
    this.lastJson = {}
    this.timelineSeenPosts = []

    this.username = null
    this.password = null
    this.authorizationData = {}
    this.lastLogin = null
    this.reloginAttempt = 0
    this.deviceSettings = {}
    this.clientSessionId = ''
    this.traySessionId = ''
    this.advertisingId = ''
    this.androidDeviceId = ''
    this.requestId = ''
    this.phoneId = ''
    this.appId = '567067343352427'
    this.uuid = ''
    this.mid = ''
    this.country = 'US'
    this.countryCode = 1
    this.locale = 'en_US'
    this.igURur = ''
    this.igWwwClaim = ''
    this.bloksVersioningId = APP_SETTINGS[DEFAULT_APP_VERSION].bloks_versioning_id
    this.userAgent = null
    this.domain = API_DOMAIN

    this.tlsVerify = tlsVerify
    this.requestTimeout = requestTimeout
    this.readTimeout = readTimeout
    this.timezoneOffset = timezoneOffset
    this.timezoneName = timezoneName
    this.pushDisabled = pushDisabled
    this.withChallengeFlow = withChallengeFlow
    this.challengeCodeHandler = challengeCodeHandler
    this.handleException = handleException
    this.challengeResolve = null
    this.overrideAppVersion = overrideAppVersion
    this.logger = logger
    this.privateRequestLogger = logger
    this.delayRange = delayRange
    this.pigeonSessionId = generateUuid('UFS-', '-1')

    this.settings = structuredClone(settings ?? {})
    this.private = new HttpSession({ verify: tlsVerify })
    this.proxy = null
    this.setProxy(proxy)
    this.init()
  }

  setProxy(dsn) {
    if (dsn) {
      if (typeof dsn !== 'string') throw new TypeError(`Proxy must be a string (URL), got ${typeof dsn}`)
      this.proxy = dsn
      const href = /^[a-z][a-z0-9+.-]*:\/\//i.test(dsn) ? dsn : `http://${dsn}`
      this.private.setProxy(href)
      return true
    }
    this.proxy = null
    this.private.setProxy(null)
    return false
  }
}

Object.defineProperties(
  Client.prototype,
  Object.assign(
    {},
    ...[
      privateMixin,
      authMixin,
      passwordMixin,
      accountMixin,
      userMixin,
      mediaMixin,
      commentMixin,
      directMixin,
      directExtraMixin,
      storyMixin,
      hashtagMixin,
      exploreMixin,
      totpMixin,
      shareMixin,
      collectionMixin,
      timelineMixin,
      locationMixin,
      highlightMixin
    ].map((mixin) => Object.getOwnPropertyDescriptors(mixin))
  )
)
