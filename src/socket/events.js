import { EventEmitter } from 'node:events'

const mergeInto = (map, name, data) => {
  const existing = map[name]
  if (existing === undefined) {
    map[name] = Array.isArray(data) ? [...data] : data
    return true
  }
  if (Array.isArray(existing) && Array.isArray(data)) {
    existing.push(...data)
    return true
  }
  if (existing && data && Array.isArray(existing.messages) && Array.isArray(data.messages) && existing.type === data.type) {
    existing.messages.push(...data.messages)
    return true
  }
  if (existing && data && Array.isArray(existing.keys) && Array.isArray(data.keys)) {
    existing.keys.push(...data.keys)
    return true
  }
  return false
}

export const makeEventBuffer = (logger) => {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)
  const processHandlers = new Set()
  let batch = {}
  let scheduled = false
  let bufferDepth = 0
  let held = []

  const deliver = () => {
    scheduled = false
    const map = batch
    batch = {}
    if (!Object.keys(map).length) return
    for (const handler of processHandlers) {
      Promise.resolve()
        .then(() => handler(map))
        .catch((error) => logger?.error?.({ err: error }, 'error in ev.process handler'))
    }
  }

  const dispatch = (name, data) => {
    emitter.emit(name, data)
    if (!processHandlers.size) return
    if (!mergeInto(batch, name, data)) {
      deliver()
      mergeInto(batch, name, data)
    }
    if (!scheduled) {
      scheduled = true
      queueMicrotask(deliver)
    }
  }

  const ev = {
    on: (name, listener) => {
      emitter.on(name, listener)
      return ev
    },
    once: (name, listener) => {
      emitter.once(name, listener)
      return ev
    },
    off: (name, listener) => {
      emitter.off(name, listener)
      return ev
    },
    removeAllListeners: (name) => {
      if (name) emitter.removeAllListeners(name)
      else {
        emitter.removeAllListeners()
        processHandlers.clear()
      }
      return ev
    },
    listenerCount: (name) => emitter.listenerCount(name),
    emit: (name, data) => {
      if (bufferDepth > 0) {
        held.push([name, data])
        return true
      }
      dispatch(name, data)
      return true
    },
    process: (handler) => {
      processHandlers.add(handler)
      return () => processHandlers.delete(handler)
    },
    buffer: () => {
      bufferDepth += 1
    },
    flush: () => {
      if (bufferDepth === 0) return false
      bufferDepth -= 1
      if (bufferDepth > 0) return false
      const pending = held
      held = []
      for (const [name, data] of pending) dispatch(name, data)
      return true
    },
    isBuffering: () => bufferDepth > 0,
    createBufferedFunction: (fn) => async (...args) => {
      ev.buffer()
      try {
        return await fn(...args)
      } finally {
        ev.flush()
      }
    }
  }
  return ev
}
