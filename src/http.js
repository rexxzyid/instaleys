import { Agent, ProxyAgent, fetch } from 'undici'
import { CookieJar } from './cookies.js'

const toQueryValue = (value) => {
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  return String(value)
}

export const buildQuery = (params) => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === null || value === undefined) continue
    search.append(key, toQueryValue(value))
  }
  return search.toString()
}

export const encodeForm = (data) => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue
    search.append(key, toQueryValue(value))
  }
  return search.toString()
}

const STRIPPED_HEADERS = new Set(['host', 'connection', 'accept-encoding', 'content-length'])

export class HttpSession {
  constructor({ verify = true, proxy = null } = {}) {
    this.verify = verify
    this.proxy = proxy
    this.cookies = new CookieJar()
    this.dispatcher = null
    this.rebuildDispatcher()
  }

  rebuildDispatcher() {
    const rejectUnauthorized = this.verify !== false
    const tls = { rejectUnauthorized }
    if (typeof this.verify === 'string') tls.ca = this.verify
    this.dispatcher = this.proxy
      ? new ProxyAgent({ uri: this.proxy, requestTls: tls })
      : new Agent({ connect: tls })
  }

  setVerify(verify) {
    this.verify = verify
    this.rebuildDispatcher()
  }

  setProxy(proxy) {
    this.proxy = proxy
    this.rebuildDispatcher()
  }

  async request(method, url, { headers = {}, body = null, params = null, timeout = 25000, cookies = true } = {}) {
    const query = buildQuery(params)
    const target = query ? `${url}${url.includes('?') ? '&' : '?'}${query}` : url
    const finalHeaders = {}
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined || value === null) continue
      if (STRIPPED_HEADERS.has(key.toLowerCase())) continue
      finalHeaders[key] = String(value)
    }
    const cookie = cookies ? this.cookies.header() : ''
    if (cookie) finalHeaders.Cookie = cookie
    const res = await fetch(target, {
      method,
      headers: finalHeaders,
      body: body ?? undefined,
      dispatcher: this.dispatcher,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout)
    })
    const text = await res.text()
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    if (cookies) this.cookies.ingest(setCookies)
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      headers: res.headers,
      url: target,
      text,
      method,
      json() {
        return JSON.parse(text)
      }
    }
  }
}
