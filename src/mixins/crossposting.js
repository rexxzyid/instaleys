import { randomUUID } from 'node:crypto'
import { API_DOMAIN } from '../config.js'
import { ClientError, ClientGraphqlError } from '../errors.js'

const FB_CROSSPOSTING_UNIFIED_CONFIG_CLIENT_DOC_ID = '216179630714134719310007237117'
const FB_CROSSPOSTING_UNIFIED_CONFIG_FRIENDLY_NAME = 'CrosspostingUnifiedConfigsQuery'
const FB_CROSSPOSTING_UNIFIED_CONFIG_ROOT_FIELD = 'xcxp_unified_crossposting_configs_root'
const FB_CONNECTED_SERVICES_CLIENT_DOC_ID = '21631519911413744205623093060'
const FB_CONNECTED_SERVICES_FRIENDLY_NAME = 'FxIgConnectedServicesInfoQuery'
const FB_CONNECTED_SERVICES_ROOT_FIELD = 'fx_service_cache'
const FB_STORY_CROSSPOSTING_SURFACE = { source_surface: 'STORY', destination_app: 'FB', destination_surface: 'STORY' }
const FB_FEED_CROSSPOSTING_SURFACE = { source_surface: 'FEED', destination_app: 'FB', destination_surface: 'FEED' }
const FB_REELS_CROSSPOSTING_SURFACE = { source_surface: 'REELS', destination_app: 'FB', destination_surface: 'REELS' }
const FB_CROSSPOSTING_SURFACES = [
  FB_STORY_CROSSPOSTING_SURFACE,
  FB_FEED_CROSSPOSTING_SURFACE,
  FB_REELS_CROSSPOSTING_SURFACE
]

const THREADS_LINKED_PROFILE_CLIENT_DOC_ID = '1294688273527445410149299611'
const THREADS_LINKED_PROFILE_FRIENDLY_NAME = 'LinkedBarcelonaProfileQuery'
const THREADS_LINKED_PROFILE_ROOT_FIELD = 'xcxp_fetch_linked_threads_profile'

const CROSSPOSTING_EXTRA_HEADERS = { Priority: 'u=3, i', 'X-FB-RMD': 'state=URL_ELIGIBLE' }
const FB_DESTINATION_TYPES = ['USER', 'PAGE']
const FB_APPS = ['FB', 'FACEBOOK']
const FB_NESTED_DESTINATION_KEYS = [
  'destination',
  'fb_destination',
  'feed_destination',
  'crosspost_destination',
  'crossposting_destination',
  'xpost_destination'
]
const FB_DESTINATION_ID_KEYS = [
  'share_to_fb_destination_id',
  'obfuscated_identity_id',
  'identity_id',
  'feed_destination_id',
  'crosspost_destination_id',
  'crossposting_destination_id',
  'xpost_destination_id',
  'destination_id'
]
const FB_DESTINATION_TYPE_KEYS = [
  'share_to_fb_destination_type',
  'identity_type',
  'crosspost_destination_type',
  'crossposting_destination_type',
  'xpost_destination_type',
  'destination_type',
  'posting_type'
]
const FB_VALIDATION_BYPASS_KEYS = ['share_to_facebook_validation_bypass', 'validation_bypass']
const THREADS_DESTINATION_ID_KEYS = ['id', 'strong_id__', 'destination_id', 'obfuscated_identity_id']
const THREADS_PROFILE_KEYS = ['username', 'profile_pic_url']

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const pyStr = (value) => {
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (value === null || value === undefined) return 'None'
  return String(value)
}

const pyTruthy = (value) => {
  if (Array.isArray(value)) return value.length > 0
  if (isPlainObject(value)) return Object.keys(value).length > 0
  return Boolean(value)
}

const textUpper = (value) => (pyTruthy(value) ? pyStr(value) : '').toUpperCase()

const withDefaultStatus = (result) => {
  if (!('status' in result)) result.status = 'ok'
  return result
}

export function* crosspostingIterDicts(value) {
  if (isPlainObject(value)) {
    yield value
    for (const child of Object.values(value)) yield* crosspostingIterDicts(child)
    return
  }
  if (Array.isArray(value)) {
    for (const child of value) yield* crosspostingIterDicts(child)
  }
}

export const crosspostingCandidateValue = (config, keys) => {
  for (const key of keys) {
    const value = config[key]
    if (value !== null && value !== undefined && value !== '') return value
  }
  return null
}

const findRootIn = (container, rootField) => {
  const root = container[rootField]
  if (root !== null && root !== undefined) return { found: true, value: root }
  for (const [key, value] of Object.entries(container)) {
    if (key.includes(rootField)) return { found: true, value }
  }
  return { found: false, value: null }
}

export const crosspostingGraphqlRoot = (config, rootField) => {
  const source = config || {}
  if (isPlainObject(source.data)) {
    const fromData = findRootIn(source.data, rootField)
    if (fromData.found) return fromData.value
  }
  const fromConfig = findRootIn(source, rootField)
  if (fromConfig.found) return fromConfig.value
  return source
}

export const crosspostingHasGraphqlRoot = (config, rootField) => {
  if (!isPlainObject(config)) return false
  const hasKey = (container) => Object.keys(container).some((key) => key.includes(rootField))
  if (isPlainObject(config.data) && hasKey(config.data)) return true
  return hasKey(config)
}

export const mediaShareToFbFeedCandidate = (config) => {
  const sourceSurface = textUpper(config.source_surface)
  const destinationSurface = textUpper(config.destination_surface)
  const destinationApp = textUpper(config.destination_app)
  if (sourceSurface && sourceSurface !== 'FEED') return false
  if (destinationSurface && destinationSurface !== 'FEED') return false
  if (destinationApp && !FB_APPS.includes(destinationApp)) return false
  return sourceSurface === 'FEED' || destinationSurface === 'FEED'
}

function* destinationIdentities(service) {
  const identityMappings = service.identity_mapping
  if (!Array.isArray(identityMappings)) return
  for (const identityMapping of identityMappings) {
    if (!isPlainObject(identityMapping)) continue
    const identities = identityMapping.destination_identities
    if (!Array.isArray(identities)) continue
    for (const destination of identities) {
      if (isPlainObject(destination)) yield destination
    }
  }
}

const serviceHasFeedSurface = (service) => {
  const customServiceData = service.custom_service_data
  const surfaceConfig = isPlainObject(customServiceData) ? customServiceData : service
  for (const candidate of crosspostingIterDicts(surfaceConfig)) {
    if (mediaShareToFbFeedCandidate(candidate)) return true
  }
  return false
}

const mergeNestedDestinations = (candidate) => {
  const merged = { ...candidate }
  for (const key of FB_NESTED_DESTINATION_KEYS) {
    if (isPlainObject(candidate[key])) Object.assign(merged, candidate[key])
  }
  return merged
}

export function* mediaShareToFbUnifiedDestinationCandidates(config) {
  const root = crosspostingGraphqlRoot(config, FB_CROSSPOSTING_UNIFIED_CONFIG_ROOT_FIELD)
  for (const service of crosspostingIterDicts(root)) {
    if (!Array.isArray(service.identity_mapping)) continue
    if (!serviceHasFeedSurface(service)) continue
    for (const destination of destinationIdentities(service)) {
      yield { ...FB_FEED_CROSSPOSTING_SURFACE, ...destination }
    }
  }
  for (const candidate of crosspostingIterDicts(root)) {
    if (mediaShareToFbFeedCandidate(candidate)) yield mergeNestedDestinations(candidate)
  }
}

const reelsAudienceType = (service) => {
  const customServiceData = service.custom_service_data
  if (!isPlainObject(customServiceData)) return null
  const privacyData = customServiceData.fb_reels_privacy_setting_service_data
  if (!isPlainObject(privacyData)) return null
  return privacyData.fb_reels_audience ?? null
}

const isIneligibleForSurface = (destination, surface) => {
  const eligibilities = destination.surface_to_xpost_eligibilities
  if (!Array.isArray(eligibilities)) return false
  return eligibilities.some(
    (eligibility) =>
      isPlainObject(eligibility) && textUpper(eligibility.surface) === surface && eligibility.is_eligible === false
  )
}

export function* fbConnectedServicesDestinationCandidates(config, surfaceName) {
  const root = crosspostingGraphqlRoot(config, FB_CONNECTED_SERVICES_ROOT_FIELD)
  if (!isPlainObject(root)) return
  const services = root.services
  if (!Array.isArray(services)) return
  const surface = surfaceName.toUpperCase()
  for (const service of services) {
    if (!isPlainObject(service)) continue
    const audienceType = surface === 'REELS' ? reelsAudienceType(service) : null
    for (const destination of destinationIdentities(service)) {
      if (isIneligibleForSurface(destination, surface)) continue
      const candidate = { source_surface: surface, destination_app: 'FB', destination_surface: surface, ...destination }
      if (pyTruthy(audienceType)) candidate.destination_audience_type = audienceType
      yield candidate
    }
  }
}

const parseValidationBypassString = (value) => {
  try {
    return JSON.parse(value)
  } catch (error) {
    if (error instanceof SyntaxError) return [value]
    throw error
  }
}

export const crosspostingValidationBypass = (input) => {
  if (input === null || input === undefined || input === '') return null
  if (Array.isArray(input) && input.length === 0) return null
  let value = typeof input === 'string' ? parseValidationBypassString(input) : input
  if (value instanceof Set) value = [...value]
  if (!Array.isArray(value)) value = [value]
  return value.map(pyStr)
}

const normalizeDestinationType = (value) => {
  let text = value !== null && value !== undefined ? pyStr(value).toUpperCase() : ''
  if (text.startsWith('FB_')) text = text.slice(3)
  return text
}

const buildFbDestination = (fbConfig, { destinationId, destinationType, validationBypass }) => {
  if (fbConfig.enabled === false || fbConfig.is_account_linked === false) {
    throw new ClientError('Facebook Feed sharing is not enabled or no Facebook account is linked')
  }
  const resolvedId = pyTruthy(destinationId) ? destinationId : crosspostingCandidateValue(fbConfig, FB_DESTINATION_ID_KEYS)
  const typeValue = pyTruthy(destinationType) ? destinationType : crosspostingCandidateValue(fbConfig, FB_DESTINATION_TYPE_KEYS)
  const typeText = normalizeDestinationType(typeValue)
  const bypassSource = validationBypass ?? crosspostingCandidateValue(fbConfig, FB_VALIDATION_BYPASS_KEYS)
  const bypass = crosspostingValidationBypass(bypassSource)
  if (!pyTruthy(resolvedId)) {
    throw new ClientError(
      'Facebook Feed sharing configuration has no destination. Link a Facebook account/page in the Instagram app or pass destination_id.'
    )
  }
  if (!typeText) {
    throw new ClientError(
      'Facebook Feed sharing configuration has no destination type. Pass destination_type as USER or PAGE.'
    )
  }
  if (!FB_DESTINATION_TYPES.includes(typeText)) {
    throw new ClientError('Facebook Feed sharing destination type must be USER or PAGE')
  }
  const destination = { destination_id: pyStr(resolvedId), destination_type: typeText }
  if (bypass && bypass.length) destination.validation_bypass = bypass
  return destination
}

const isEmptyConfig = (config) => !config || Object.keys(config).length === 0

const firstResolvedDestination = async (client, candidates, opts = {}) => {
  for (const candidate of candidates) {
    try {
      return await client.mediaShareToFbDestination({ ...opts, config: candidate, useUnifiedConfig: false })
    } catch (error) {
      if (!(error instanceof ClientError)) throw error
    }
  }
  return null
}

export const crosspostingMixin = {
  async mediaShareToFbUnifiedConfig(crosspostAppSurfaceList = null) {
    const surfaces = crosspostAppSurfaceList && crosspostAppSurfaceList.length ? crosspostAppSurfaceList : FB_CROSSPOSTING_SURFACES
    const result = await this.privateGraphqlWwwRequest({
      friendlyName: FB_CROSSPOSTING_UNIFIED_CONFIG_FRIENDLY_NAME,
      variables: { configs_request: { source_app: 'IG', crosspost_app_surface_list: surfaces } },
      clientDocId: FB_CROSSPOSTING_UNIFIED_CONFIG_CLIENT_DOC_ID,
      domain: API_DOMAIN,
      extraHeaders: { 'X-Root-Field-Name': FB_CROSSPOSTING_UNIFIED_CONFIG_ROOT_FIELD, ...CROSSPOSTING_EXTRA_HEADERS },
      purpose: null
    })
    return withDefaultStatus(result)
  },

  async mediaShareToFbConnectedServicesConfig() {
    const variables = {
      service_names: ['CROSS_POSTING_SETTING'],
      custom_partner_params: [
        { value: 'FB', key: 'CROSSPOSTING_DESTINATION_APP' },
        { value: '', key: 'CROSSPOSTING_SHARE_TO_SURFACE' },
        { value: 'true', key: 'OVERRIDE_USER_VALIDATION_WITH_CXP_ELIGIBILITY_RULE' }
      ],
      client_caller_name: 'ig_android_service_cache_crossposting_setting',
      caller_name: 'fx_product_foundation_client_FXOnline_client_cache'
    }
    const result = await this.privateGraphqlWwwRequest({
      friendlyName: FB_CONNECTED_SERVICES_FRIENDLY_NAME,
      variables,
      clientDocId: FB_CONNECTED_SERVICES_CLIENT_DOC_ID,
      domain: API_DOMAIN,
      extraHeaders: { ...CROSSPOSTING_EXTRA_HEADERS, 'X-Root-Field-Name': FB_CONNECTED_SERVICES_ROOT_FIELD },
      purpose: null
    })
    return withDefaultStatus(result)
  },

  async mediaShareToFbUnifiedDestination(config = null) {
    const loaders = config !== null
      ? [async () => config]
      : [
          async () => this.mediaShareToFbUnifiedConfig(),
          async () => this.mediaShareToFbUnifiedConfig([FB_FEED_CROSSPOSTING_SURFACE])
        ]
    for (const load of loaders) {
      const unifiedConfig = await load()
      const resolved = await firstResolvedDestination(this, mediaShareToFbUnifiedDestinationCandidates(unifiedConfig || {}))
      if (resolved) return resolved
    }
    if (config === null) {
      const connected = await this.mediaShareToFbConnectedServicesConfig()
      const resolved = await firstResolvedDestination(this, fbConnectedServicesDestinationCandidates(connected, 'FEED'))
      if (resolved) return resolved
    }
    throw new ClientError('Facebook Feed cross-posting config has no confirmed Facebook destination')
  },

  async mediaShareToFbDestination(opts = {}) {
    const {
      config = null,
      destinationId = null,
      destinationType = null,
      validationBypass = null,
      useUnifiedConfig = true
    } = opts
    const explicitDestination = Boolean(destinationId || destinationType)
    const completeExplicitDestination = Boolean(destinationId && destinationType)
    const overrides = { destinationId, destinationType, validationBypass }
    const hasConfig = !isEmptyConfig(config)

    if (hasConfig && crosspostingHasGraphqlRoot(config, FB_CONNECTED_SERVICES_ROOT_FIELD) && !completeExplicitDestination) {
      const resolved = await firstResolvedDestination(
        this,
        fbConnectedServicesDestinationCandidates(config, 'FEED'),
        overrides
      )
      if (resolved) return resolved
      throw new ClientError('Facebook connected-services config has no eligible Feed destination')
    }

    if (hasConfig && crosspostingHasGraphqlRoot(config, FB_CROSSPOSTING_UNIFIED_CONFIG_ROOT_FIELD) && !completeExplicitDestination) {
      const candidates = [...mediaShareToFbUnifiedDestinationCandidates(config)]
      const resolved = await firstResolvedDestination(this, candidates, overrides)
      if (resolved) return resolved
    }

    const fbConfig = config || {}
    if (isEmptyConfig(fbConfig) && !explicitDestination && useUnifiedConfig) {
      return this.mediaShareToFbUnifiedDestination()
    }
    return buildFbDestination(fbConfig, overrides)
  },

  async mediaShareToFbExtraData(opts = {}) {
    const { config = null, destinationId = null, destinationType = null, validationBypass = null, attemptId = null } = opts
    const destination = await this.mediaShareToFbDestination({ config, destinationId, destinationType, validationBypass })
    const data = {
      share_to_facebook: '1',
      share_to_fb_destination_id: destination.destination_id,
      share_to_fb_destination_type: destination.destination_type,
      no_token_crosspost: '1',
      attempt_id: attemptId || randomUUID()
    }
    if (destination.validation_bypass) data.share_to_facebook_validation_bypass = destination.validation_bypass
    return data
  },

  async mediaShareToThreadsConfig() {
    let result
    try {
      result = await this.privateGraphqlWwwRequest({
        friendlyName: THREADS_LINKED_PROFILE_FRIENDLY_NAME,
        variables: {},
        clientDocId: THREADS_LINKED_PROFILE_CLIENT_DOC_ID,
        domain: API_DOMAIN,
        extraHeaders: { 'X-Root-Field-Name': THREADS_LINKED_PROFILE_ROOT_FIELD, ...CROSSPOSTING_EXTRA_HEADERS },
        purpose: null
      })
    } catch (error) {
      if (!(error instanceof ClientGraphqlError)) throw error
      result = await this.privateGraphqlQueryRequest({
        friendlyName: THREADS_LINKED_PROFILE_FRIENDLY_NAME,
        rootFieldName: THREADS_LINKED_PROFILE_ROOT_FIELD,
        variables: {},
        clientDocId: THREADS_LINKED_PROFILE_CLIENT_DOC_ID,
        priority: 'u=3, i',
        extraHeaders: { 'X-FB-RMD': 'state=URL_ELIGIBLE' }
      })
    }
    return withDefaultStatus(result)
  },

  async mediaShareToThreadsDestination(opts = {}) {
    const { config = null, destinationId = null } = opts
    let threadsConfig = config
    if (threadsConfig === null && destinationId === null) threadsConfig = await this.mediaShareToThreadsConfig()
    const root = threadsConfig !== null ? crosspostingGraphqlRoot(threadsConfig || {}, THREADS_LINKED_PROFILE_ROOT_FIELD) : {}
    const profile = isPlainObject(root) ? root : {}
    const resolvedId = pyTruthy(destinationId) ? destinationId : crosspostingCandidateValue(profile, THREADS_DESTINATION_ID_KEYS)
    if (!pyTruthy(resolvedId)) {
      throw new ClientError(
        'Threads sharing configuration has no linked Threads profile. Link a Threads profile in the Instagram app or pass destination_id.'
      )
    }
    const destination = { destination_id: pyStr(resolvedId) }
    for (const key of THREADS_PROFILE_KEYS) {
      if (pyTruthy(profile[key])) destination[key] = pyStr(profile[key])
    }
    return destination
  },

  async mediaShareToThreadsExtraData(opts = {}) {
    const { config = null, destinationId = null, validationBypass = null } = opts
    const destination = await this.mediaShareToThreadsDestination({ config, destinationId })
    const data = {
      share_to_threads: '1',
      share_to_threads_destination_id: destination.destination_id
    }
    const bypass = crosspostingValidationBypass(validationBypass)
    if (bypass && bypass.length) data.share_to_threads_validation_bypass = bypass
    return data
  }
}
