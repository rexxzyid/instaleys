export class CookieJar {
  constructor(initial = {}) {
    this.store = new Map(Object.entries(initial))
  }

  get(name) {
    return this.store.get(name)
  }

  set(name, value) {
    this.store.set(name, String(value))
  }

  delete(name) {
    this.store.delete(name)
  }

  clear() {
    this.store.clear()
  }

  toObject() {
    return Object.fromEntries(this.store)
  }

  header() {
    return [...this.store].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  ingest(setCookieHeaders = []) {
    for (const raw of setCookieHeaders) {
      const [pair, ...attrs] = raw.split(';').map((part) => part.trim())
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq)
      const value = pair.slice(eq + 1)
      let expired = false
      for (const attr of attrs) {
        const [key, val] = attr.split('=')
        const lower = key.toLowerCase()
        if (lower === 'max-age' && Number(val) <= 0) expired = true
        if (lower === 'expires' && Date.parse(val) < Date.now()) expired = true
      }
      if (expired) this.store.delete(name)
      else this.store.set(name, value)
    }
  }
}
