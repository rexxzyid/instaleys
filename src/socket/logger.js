const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: 100 }

export const createLogger = (level = 'silent', bindings = {}) => {
  const threshold = LEVELS[level] ?? LEVELS.silent
  const write = (name, stream) => (...args) => {
    if (LEVELS[name] < threshold) return
    const [first, ...rest] = args
    const prefix = `[${new Date().toISOString()}] ${name.toUpperCase()}`
    if (first && typeof first === 'object' && !(first instanceof Error)) {
      stream(prefix, JSON.stringify({ ...bindings, ...first }), ...rest)
    } else {
      stream(prefix, ...args)
    }
  }
  return {
    level,
    trace: write('trace', console.debug),
    debug: write('debug', console.debug),
    info: write('info', console.info),
    warn: write('warn', console.warn),
    error: write('error', console.error),
    fatal: write('fatal', console.error),
    child: (extra = {}) => createLogger(level, { ...bindings, ...extra })
  }
}
