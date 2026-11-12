import { API_DOMAIN } from '../config.js'
import {
  ChallengeRequired,
  ClientBadRequestError,
  ClientConnectionError,
  ClientError,
  ClientForbiddenError,
  ClientGraphqlError,
  ClientJSONDecodeError,
  ClientNotFoundError,
  ClientThrottledError,
  ClientUnauthorizedError,
  FeedbackRequired,
  LoginRequired,
  PrivateAccount,
  RateLimitError,
  SentryBlock,
  UserNotFound
} from '../errors.js'
import { encodeForm } from '../http.js'

const mergeIncrementalPayload = (base, payload) => {
  const path = payload.path
  if (!Array.isArray(path) || !path.length || !('data' in payload)) return
  let target = base
  let keys = path
  if (path[0] !== 'data') target = base.data ?? {}
  else keys = path.slice(1)
  if (!keys.length) return
  try {
    for (const key of keys.slice(0, -1)) target = target[key]
  } catch {
    return
  }
  const lastKey = keys.at(-1)
  const value = payload.data
  if (Array.isArray(target)) {
    if (!Number.isInteger(lastKey)) return
    try {
      target[lastKey] = value
    } catch {
      return
    }
    return
  }
  target[lastKey] = value
}

const parseGraphqlBody = (response) => {
  try {
    return response.json()
  } catch (error) {
    const lines = response.text.split('\n').filter((line) => line.trim())
    if (!lines.length) {
      throw new ClientJSONDecodeError(`JSONDecodeError ${error.message} while opening ${response.url}`, { response })
    }
    const body = JSON.parse(lines[0])
    for (const line of lines.slice(1)) mergeIncrementalPayload(body, JSON.parse(line))
    return body
  }
}

export const PRIVATE_GRAPHQL_WWW_DOMAIN = 'b.i.instagram.com'

const GRAPHQL_STATUS_ERRORS = {
  400: ClientBadRequestError,
  401: ClientUnauthorizedError,
  403: ClientForbiddenError,
  404: ClientNotFoundError,
  429: ClientThrottledError
}

const readJsonObject = (response) => {
  try {
    const body = response.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

const graphqlHttpError = (response, lastJson) => {
  const label = `HTTP ${response.status}`
  const props = { response, ...lastJson }
  const message = String(lastJson.message ?? '').toLowerCase()
  if (message === 'login_required') return new LoginRequired(label, props)
  if (message === 'challenge_required') return new ChallengeRequired('', lastJson)
  if (message === 'feedback_required') return new FeedbackRequired(label, props)
  if (lastJson.error_type === 'rate_limit_error') return new RateLimitError(label, props)
  if (message === 'user_blocked') return new SentryBlock(label, props)
  if (message.includes('not authorized to view user')) return new PrivateAccount(label, props)
  if (message.includes('unable to fetch followers') || message.includes('error generating user info response')) {
    return new UserNotFound(label, props)
  }
  if (response.status === 404 && response.text === 'Not Found') return new ChallengeRequired('', lastJson)
  const ErrorClass = GRAPHQL_STATUS_ERRORS[response.status] ?? ClientError
  return new ErrorClass(label, props)
}

const mergeHeaders = (base, overrides) => {
  const merged = { ...base }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const lower = key.toLowerCase()
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === lower) delete merged[existing]
    }
    merged[key] = value
  }
  return merged
}

const graphqlFormData = (friendlyName, variables) => ({
  method: 'post',
  pretty: 'false',
  format: 'json',
  server_timestamps: 'true',
  locale: 'user',
  fb_api_req_friendly_name: friendlyName,
  enable_canonical_naming: 'true',
  enable_canonical_variable_overrides: 'true',
  enable_canonical_naming_ambiguous_type_prefixing: 'true',
  variables: JSON.stringify(variables ?? {})
})

export const graphqlMixin = {
  raiseGraphqlHttpError(response) {
    const body = readJsonObject(response)
    if (body) this.lastJson = body
    throw graphqlHttpError(response, body ?? {})
  },

  async privateGraphqlWwwRequest({
    friendlyName,
    variables = null,
    clientDocId = null,
    domain = PRIVATE_GRAPHQL_WWW_DOMAIN,
    extraHeaders = null,
    purpose = 'fetch'
  }) {
    const data = graphqlFormData(friendlyName, variables)
    if (purpose !== null) data.purpose = purpose
    if (clientDocId) data.client_doc_id = String(clientDocId)
    const ownHeaders = {
      'X-FB-Friendly-Name': friendlyName,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    }
    if (clientDocId) ownHeaders['X-Client-Doc-Id'] = String(clientDocId)
    const headers = mergeHeaders(this.baseHeaders, { ...ownHeaders, ...(extraHeaders ?? {}), Host: domain })
    const hasAuthorization = Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')
    if (this.authorization && !hasAuthorization) headers.Authorization = this.authorization
    if (this.requestTimeout) await new Promise((resolve) => setTimeout(resolve, this.requestTimeout * 1000))
    const url = `https://${domain}/graphql_www`
    this.logger.info(url)

    let response
    try {
      this.privateRequestsCount += 1
      response = await this.private.request('POST', url, {
        headers,
        body: encodeForm(data),
        timeout: this.readTimeout * 1000
      })
    } catch (error) {
      throw new ClientConnectionError(`${error?.name ?? 'Error'} ${error?.message ?? error}`)
    }
    this.lastResponse = response
    if (!response.ok) this.raiseGraphqlHttpError(response)

    const body = parseGraphqlBody(response)
    this.lastJson = body
    if (body.errors) throw new ClientGraphqlError('', { ...body })
    if (body.status === 'fail') throw new ClientError('', { response, ...body })
    return body
  },

  async privateGraphqlRequest(data, { headers = null, domain = null } = {}) {
    this.lastResponse = null
    this.lastJson = {}
    let requestHeaders = mergeHeaders(this.baseHeaders, {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    })
    if (this.authorization) requestHeaders.Authorization = this.authorization
    if (data.fb_api_req_friendly_name) {
      requestHeaders = mergeHeaders(requestHeaders, { 'X-FB-Friendly-Name': data.fb_api_req_friendly_name })
    }
    requestHeaders = mergeHeaders(requestHeaders, headers)
    if (this.requestTimeout) await new Promise((resolve) => setTimeout(resolve, this.requestTimeout * 1000))
    const url = `https://${domain ?? API_DOMAIN}/graphql/query`
    this.logger.info(url)

    let response
    try {
      this.privateRequestsCount += 1
      response = await this.private.request('POST', url, {
        headers: requestHeaders,
        body: encodeForm(data),
        timeout: this.readTimeout * 1000
      })
    } catch (error) {
      throw new ClientConnectionError(`${error?.name ?? 'Error'} ${error?.message ?? error}`)
    }
    this.lastResponse = response

    if (!response.ok) {
      let json = {}
      try {
        json = response.json()
      } catch {
        json = {}
      }
      this.lastJson = json
      this.throwHttpError(response, 'graphql/query', json)
    }

    const body = parseGraphqlBody(response)
    this.lastJson = body
    if (body.errors) throw new ClientGraphqlError('', { ...body })
    if (body.status === 'fail') throw new ClientError('', { response, ...body })
    return body
  },

  async privateGraphqlQueryRequest({
    friendlyName,
    rootFieldName,
    variables = {},
    clientDocId = null,
    priority = null,
    extraHeaders = null
  }) {
    const data = graphqlFormData(friendlyName, variables)
    if (clientDocId) data.client_doc_id = String(clientDocId)
    const headers = {
      'X-FB-Friendly-Name': friendlyName,
      'X-Root-Field-Name': rootFieldName,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    }
    if (clientDocId) headers['X-Client-Doc-Id'] = String(clientDocId)
    if (priority) headers.Priority = priority
    return this.privateGraphqlRequest(data, { headers: { ...headers, ...(extraHeaders ?? {}) } })
  },

  async privateGraphqlMemoriesPog(clientDocId = '4160563056814166588457451196', directRegionHint = null) {
    const extraHeaders = directRegionHint ? { 'ig-u-ig-direct-region-hint': directRegionHint } : null
    return this.privateGraphqlQueryRequest({
      friendlyName: 'MemoriesPogQuery',
      rootFieldName: 'xdt_get_story_memories_pog',
      variables: { request: { user_id: 0 } },
      clientDocId,
      extraHeaders
    })
  },

  async privateGraphqlRealtimeRegionHint(clientDocId = '52232106018313849661757113193') {
    return this.privateGraphqlQueryRequest({
      friendlyName: 'IGRealtimeRegionHintQuery',
      rootFieldName: 'xdt_igd_msg_region',
      variables: {},
      clientDocId,
      priority: 'u=3, i'
    })
  },

  async privateGraphqlTopAudioTrendsEligibleCategories(clientDocId = '10243243298540497152200027985') {
    return this.privateGraphqlQueryRequest({
      friendlyName: 'GetTopAudioTrendsEligibleCategories',
      rootFieldName: 'xdt_top_audio_trends_eligible_tabs',
      variables: {},
      clientDocId
    })
  },

  async privateGraphqlUpdateInboxTrayLastSeen(clientDocId = '41048505499858972910914091441') {
    return this.privateGraphqlQueryRequest({
      friendlyName: 'UpdateInboxTrayLastSeenTimestamp',
      rootFieldName: '__typename',
      variables: {},
      clientDocId
    })
  }
}
