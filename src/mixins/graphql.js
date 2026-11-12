import { API_DOMAIN } from '../config.js'
import { ClientConnectionError, ClientError, ClientGraphqlError, ClientJSONDecodeError } from '../errors.js'
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

export const graphqlMixin = {
  async privateGraphqlRequest(data, { headers = null, domain = null } = {}) {
    this.lastResponse = null
    this.lastJson = {}
    const requestHeaders = { ...this.baseHeaders, ...(headers ?? {}) }
    requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
    if (data.fb_api_req_friendly_name) requestHeaders['X-FB-Friendly-Name'] = data.fb_api_req_friendly_name
    if (this.authorization) requestHeaders.Authorization = this.authorization
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
    const data = {
      method: 'post',
      pretty: 'false',
      format: 'json',
      server_timestamps: 'true',
      locale: 'user',
      fb_api_req_friendly_name: friendlyName,
      enable_canonical_naming: 'true',
      enable_canonical_variable_overrides: 'true',
      enable_canonical_naming_ambiguous_type_prefixing: 'true',
      variables: JSON.stringify(variables)
    }
    if (clientDocId) data.client_doc_id = String(clientDocId)
    const headers = {
      'X-FB-Friendly-Name': friendlyName,
      'X-Root-Field-Name': rootFieldName,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    }
    if (clientDocId) headers['X-Client-Doc-Id'] = String(clientDocId)
    if (priority) headers.Priority = priority
    return this.privateGraphqlRequest(data, { headers: { ...headers, ...(extraHeaders ?? {}) } })
  }
}