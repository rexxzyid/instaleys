import { API_DOMAIN, DEFAULT_APP_VERSION, APP_SETTINGS } from './config.js'
import { HttpSession } from './http.js'
import { generateUuid } from './utils.js'
import { manualChangePassword, manualInputCode, privateMixin } from './mixins/private.js'
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
import { graphqlMixin } from './mixins/graphql.js'
import { noteMixin } from './mixins/note.js'
import { insightsMixin } from './mixins/insights.js'
import { fbsearchMixin } from './mixins/fbsearch.js'
import { multipleAccountsMixin, notificationMixin } from './mixins/notification.js'
import { trackMixin } from './mixins/track.js'
import { fundraiserMixin } from './mixins/fundraiser.js'
import { quicksnapMixin } from './mixins/quicksnap.js'
import { crosspostingMixin } from './mixins/crossposting.js'
import { captchaMixin } from './mixins/captcha.js'
import { attestationMixin } from './mixins/attestation.js'
import { bloksMixin } from './mixins/bloks.js'
import { CHALLENGE_WAIT_SECONDS, challengeMixin } from './mixins/challenge.js'

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
    changePasswordHandler = manualChangePassword,
    handleException = null,
    email = null,
    phoneNumber = null
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
    this.usdid = ''
    this.usdidKid = ''
    this.usdidPrivateKey = ''
    this.usdidRegistered = false
    this.attestationChallengeNonce = ''
    this.attestationKeyNonce = ''
    this.usdidHeaderCache = ''
    this.usdidHeaderExpiresAt = 0
    this.captchaHandlerInstance = null
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
    this.changePasswordHandler = changePasswordHandler
    this.challengeWaitSeconds = CHALLENGE_WAIT_SECONDS
    this.email = email
    this.phoneNumber = phoneNumber
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
      highlightMixin,
      graphqlMixin,
      noteMixin,
      insightsMixin,
      fbsearchMixin,
      notificationMixin,
      multipleAccountsMixin,
      trackMixin,
      fundraiserMixin,
      quicksnapMixin,
      crosspostingMixin,
      captchaMixin,
      attestationMixin,
      bloksMixin,
      challengeMixin
    ].map((mixin) => Object.getOwnPropertyDescriptors(mixin))
  )
)
