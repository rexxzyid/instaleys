import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const initAuthCreds = () => ({
  settings: null,
  me: null,
  registered: false,
  createdAt: Date.now()
})

const fixFileName = (name) => name?.replace(/\//g, '__')?.replace(/:/g, '-')

const locks = new Map()

const withLock = (path, task) => {
  const previous = locks.get(path) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(task)
  locks.set(path, next)
  next.finally(() => {
    if (locks.get(path) === next) locks.delete(path)
  }).catch(() => {})
  return next
}

const writeAtomic = async (path, data) => {
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, data, { mode: 0o600 })
  await rename(temp, path)
}

export const useMultiFileAuthState = async (folder) => {
  await mkdir(folder, { recursive: true })
  const info = await stat(folder)
  if (!info.isDirectory()) throw new Error(`${folder} exists and is not a directory`)

  const writeData = (data, file) =>
    withLock(file, () => writeAtomic(join(folder, fixFileName(file)), JSON.stringify(data)))

  const readData = async (file) => {
    try {
      return await withLock(file, async () =>
        JSON.parse(await readFile(join(folder, fixFileName(file)), 'utf8'))
      )
    } catch {
      return null
    }
  }

  const removeData = async (file) => {
    try {
      await withLock(file, () => rm(join(folder, fixFileName(file)), { force: true }))
    } catch {
      return
    }
  }

  const creds = (await readData('creds.json')) ?? initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          await Promise.all(
            ids.map(async (id) => {
              const value = await readData(`${type}-${id}.json`)
              if (value !== null) data[id] = value
            })
          )
          return data
        },
        set: async (data) => {
          const tasks = []
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id]
              const file = `${category}-${id}.json`
              tasks.push(value ? writeData(value, file) : removeData(file))
            }
          }
          await Promise.all(tasks)
        },
        clear: async () => {
          const files = await readdir(folder)
          await Promise.all(files.filter((file) => file !== 'creds.json').map((file) => rm(join(folder, file), { force: true })))
        }
      }
    },
    saveCreds: () => writeData(creds, 'creds.json')
  }
}

export const useInMemoryAuthState = () => {
  const creds = initAuthCreds()
  const store = new Map()
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {}
          for (const id of ids) {
            const value = store.get(`${type}:${id}`)
            if (value !== undefined) data[id] = structuredClone(value)
          }
          return data
        },
        set: async (data) => {
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id]
              if (value) store.set(`${category}:${id}`, structuredClone(value))
              else store.delete(`${category}:${id}`)
            }
          }
        },
        clear: async () => store.clear()
      }
    },
    saveCreds: async () => {}
  }
}
