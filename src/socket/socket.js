import { Client } from '../client.js'
import {
  AccountSuspended,
  BadCredentials,
  BadPassword,
  ChallengeRequired,
  ClientThrottledError,
  FeedbackRequired,
  LoginRequired,
  PleaseWaitFewMinutes,
  RateLimitError,
  SentryBlock,
  TwoFactorRequired
} from '../errors.js'
import { sleep } from '../utils.js'
import { useInMemoryAuthState } from './auth-state.js'
import { DEFAULT_SOCKET_CONFIG, DisconnectError, DisconnectReason } from './defaults.js'
import { makeEventBuffer } from './events.js'
import { resolveRealtimeTransport } from './transport.js'
import { groupJid, userJid } from './jid.js'
import { createLogger } from './logger.js'
import { convertItem, toSeconds } from './messages.js'
import { buildSocketApi } from './socket-api.js'

const THROTTLE_ERRORS = [ClientThrottledError, PleaseWaitFewMinutes, RateLimitError, FeedbackRequired, SentryBlock]
const STATE_LIMIT = 200

const emptyThreadState = () => ({
  initialized: false,
  seen: [],
  recent: [],
  read: [],
  lastSeen: {},
  rx: {}
})

const trim = (list, size = STATE_LIMIT) => (list.length > size ? list.slice(list.length - size) : list)

export const makeIGSocket = (userConfig = {}) => {
  const config = { ...DEFAULT_SOCKET_CONFIG, ...userConfig }
  const transport = resolveRealtimeTransport(config.transport)
  const logger = config.logger ?? createLogger('silent')
  const auth = config.auth ?? useInMemoryAuthState().state
  const ev = makeEventBuffer(logger)

  const client = new Client({
    settings: auth.creds.settings ?? {},
    proxy: config.proxy,
    delayRange: config.delayRange,
    requestTimeout: config.requestTimeout,
    logger: logger.child({ module: 'client' }),
    ...config.clientOptions
  })
  if (!auth.creds.settings && config.device) client.setDevice(config.device)
  if ('requestTimeout' in userConfig) client.requestTimeout = userConfig.requestTimeout

  const runtime = {
    config,
    transport,
    logger,
    auth,
    ev,
    client,
    closed: false,
    connected: false,
    user: null,
    account: null,
    timer: null,
    pollCount: 0,
    failures: 0,
    degraded: false,
    settingsHash: '',
    threadChat: new Map(),
    jidThread: new Map(),
    threadStates: new Map(),
    dirtyStates: new Set(),
    chatSnapshots: new Map(),
    groupSnapshots: new Map(),
    contactSnapshots: new Map(),
    sentIds: new Set()
  }

  const updateCreds = (update) => {
    Object.assign(auth.creds, update)
    ev.emit('creds.update', update)
  }

  const syncSettings = () => {
    const settings = client.getSettings()
    const hash = JSON.stringify(settings)
    if (hash === runtime.settingsHash) return
    runtime.settingsHash = hash
    updateCreds({ settings })
  }

  const close = (error) => {
    if (runtime.closed) return
    runtime.closed = true
    runtime.connected = false
    clearTimeout(runtime.timer)
    ev.emit('connection.update', { connection: 'close', lastDisconnect: { error, date: new Date() } })
  }

  const selfIdentity = () => ({
    selfPk: String(client.userId),
    selfJid: runtime.user?.id,
    selfName: runtime.user?.name
  })

  const getThreadState = async (threadId) => {
    const id = String(threadId)
    if (runtime.threadStates.has(id)) return runtime.threadStates.get(id)
    let loaded = null
    if (auth.keys) {
      const stored = await auth.keys.get('thread-state', [id])
      loaded = stored[id] ?? null
    }
    const state = loaded
      ? {
          ...emptyThreadState(),
          ...loaded,
          seen: new Set(loaded.seen ?? []),
          read: new Set(loaded.read ?? []),
          initialized: true
        }
      : { ...emptyThreadState(), seen: new Set(), read: new Set() }
    runtime.threadStates.set(id, state)
    return state
  }

  const markDirty = (threadId) => runtime.dirtyStates.add(String(threadId))

  const persistThreadStates = async () => {
    if (!auth.keys || !runtime.dirtyStates.size) return
    const payload = {}
    for (const id of runtime.dirtyStates) {
      const state = runtime.threadStates.get(id)
      if (!state) continue
      payload[id] = {
        initialized: true,
        seen: trim([...state.seen]),
        read: trim([...state.read]),
        recent: trim(state.recent),
        lastSeen: state.lastSeen,
        rx: state.rx
      }
    }
    runtime.dirtyStates.clear()
    await auth.keys.set({ 'thread-state': payload })
  }

  const chatIdentity = (thread) => {
    const others = thread.users ?? []
    const isGroup = thread.is_group === true || others.length > 1
    if (isGroup) return { jid: groupJid(thread.id), isGroup: true }
    if (others.length === 1) return { jid: userJid(others[0].pk), isGroup: false }
    return { jid: groupJid(thread.id), isGroup: thread.is_group === true }
  }

  const contextFor = (thread, identity = chatIdentity(thread)) => {
    const { selfPk, selfJid, selfName } = selfIdentity()
    const users = new Map()
    for (const user of [...(thread.users ?? []), ...(thread.left_users ?? [])]) users.set(String(user.pk), user)
    users.set(selfPk, { pk: selfPk, full_name: selfName, username: runtime.user?.username })
    return {
      chatJid: identity.jid,
      threadId: String(thread.id),
      selfPk,
      selfJid,
      selfName,
      isGroup: identity.isGroup,
      users
    }
  }

  const buildContact = (user) => ({
    id: userJid(user.pk),
    name: user.full_name || undefined,
    notify: user.username || undefined,
    username: user.username || undefined,
    imgUrl: user.profile_pic_url || undefined,
    verified: user.is_verified ?? undefined
  })

  const buildGroup = (thread, jid, selfPk) => {
    const admins = new Set((thread.admin_user_ids ?? []).map(String))
    const members = [...(thread.users ?? [])].map((user) => ({
      id: userJid(user.pk),
      admin: admins.has(String(user.pk)) ? 'admin' : null
    }))
    members.push({ id: userJid(selfPk), admin: admins.has(String(selfPk)) ? 'admin' : null })
    return {
      id: jid,
      threadId: String(thread.id),
      subject: thread.thread_title || undefined,
      owner: thread.inviter ? userJid(thread.inviter.pk) : undefined,
      participants: members,
      size: members.length,
      joinApprovalMode: Boolean(thread.approval_required_for_new_members),
      announce: false,
      restrict: false
    }
  }

  const unreadCount = (thread, messages, selfPk) => {
    const selfSeen = thread.last_seen_at?.[selfPk]
    if (selfSeen) {
      const seenAt = toSeconds(selfSeen.timestamp)
      return messages.filter((m) => !m.key.fromMe && m.message && m.messageTimestamp > seenAt).length
    }
    return thread.read_state > 0 ? 1 : 0
  }

  const buildChat = (thread, identity, messages, selfPk) => {
    const other = identity.isGroup ? null : thread.users?.[0]
    const stamp = toSeconds(thread.last_activity_at)
    return {
      id: identity.jid,
      threadId: String(thread.id),
      isGroup: identity.isGroup,
      name: thread.thread_title || other?.full_name || other?.username || undefined,
      conversationTimestamp: stamp,
      unreadCount: unreadCount(thread, messages, selfPk),
      archived: Boolean(thread.archived),
      pinned: thread.is_pin ? stamp : undefined,
      muteEndTime: thread.muted ? Number.MAX_SAFE_INTEGER : null,
      pending: Boolean(thread.pending),
      readOnly: false
    }
  }

  const diffObject = (previous, next) => {
    const diff = {}
    for (const key of Object.keys(next)) {
      if (JSON.stringify(previous?.[key]) !== JSON.stringify(next[key])) diff[key] = next[key]
    }
    return diff
  }

  const newOut = () => ({
    chats: [],
    chatUpdates: [],
    contacts: [],
    contactUpdates: [],
    groupsUpsert: [],
    groupsUpdate: [],
    participants: [],
    history: [],
    notify: [],
    updates: [],
    deletes: [],
    reactions: [],
    receipts: []
  })

  const processThread = async (thread, out, { initial }) => {
    const { selfPk, selfJid } = selfIdentity()
    const threadId = String(thread.id)
    const identity = chatIdentity(thread)
    if (config.shouldIgnoreJid(identity.jid)) return
    runtime.threadChat.set(threadId, identity)
    runtime.jidThread.set(identity.jid, threadId)

    const ctx = contextFor(thread, identity)
    const state = await getThreadState(threadId)
    const wasInitialized = state.initialized
    const asHistory = initial && !wasInitialized

    const messages = [...(thread.messages ?? [])]
      .map((item) => convertItem(item, ctx))
      .sort((a, b) => a.messageTimestamp - b.messageTimestamp)
    const currentIds = new Set(messages.map((m) => m.key.id))
    const fresh = messages.filter((m) => !state.seen.has(m.key.id))
    const freshIds = new Set(fresh.map((m) => m.key.id))

    const readers = Object.entries(thread.last_seen_at ?? {}).filter(([uid]) => uid !== selfPk)
    for (const message of messages) {
      if (!message.key.fromMe) continue
      const readBy = readers.filter(([, seen]) => toSeconds(seen.timestamp) >= message.messageTimestamp)
      if (!readBy.length) continue
      message.status = 'READ'
      if (state.read.has(message.key.id)) continue
      state.read.add(message.key.id)
      if (!freshIds.has(message.key.id) && wasInitialized) {
        out.updates.push({ key: message.key, update: { status: 'READ' } })
        for (const [uid, seen] of readBy) {
          out.receipts.push({
            key: message.key,
            receipt: { userJid: userJid(uid), readTimestamp: toSeconds(seen.timestamp) }
          })
        }
      }
    }

    if (wasInitialized) {
      for (const message of messages) {
        if (freshIds.has(message.key.id)) continue
        const previous = state.rx[message.key.id] ?? {}
        const current = {}
        for (const reaction of message.reactions ?? []) current[reaction.key.participant] = reaction
        for (const [participant, reaction] of Object.entries(current)) {
          if (previous[participant] !== reaction.text) out.reactions.push({ key: message.key, reaction })
        }
        for (const participant of Object.keys(previous)) {
          if (current[participant]) continue
          out.reactions.push({
            key: message.key,
            reaction: {
              key: { remoteJid: identity.jid, fromMe: participant === selfJid, id: message.key.id, participant },
              text: '',
              senderTimestampMs: Date.now()
            }
          })
        }
      }
    }
    for (const message of messages) {
      const map = {}
      for (const reaction of message.reactions ?? []) map[reaction.key.participant] = reaction.text
      if (Object.keys(map).length) state.rx[message.key.id] = map
      else delete state.rx[message.key.id]
    }

    if (wasInitialized && messages.length) {
      const limit = config.messageLimit
      const oldest = messages.length >= limit ? messages[0].messageTimestamp : 0
      const missing = state.recent.filter(
        (entry) => entry.ts > oldest && !currentIds.has(entry.id) && !runtime.sentIds.has(entry.id)
      )
      for (const entry of missing) {
        out.deletes.push({ remoteJid: identity.jid, fromMe: entry.fromMe, id: entry.id, threadId })
      }
    }

    for (const message of fresh) {
      state.seen.add(message.key.id)
      if (runtime.sentIds.has(message.key.id)) continue
      if (asHistory) {
        if (config.shouldSyncHistoryMessage(message)) out.history.push(message)
      } else {
        out.notify.push(message)
      }
    }
    const removed = new Set(out.deletes.filter((key) => key.threadId === threadId).map((key) => key.id))
    state.recent = trim(
      [
        ...state.recent.filter((entry) => !removed.has(entry.id) && !currentIds.has(entry.id)),
        ...messages.map((m) => ({ id: m.key.id, ts: m.messageTimestamp, fromMe: m.key.fromMe }))
      ].sort((a, b) => a.ts - b.ts)
    )
    state.lastSeen = Object.fromEntries(readers.map(([uid, seen]) => [uid, seen.item_id]))
    state.initialized = true
    markDirty(threadId)

    const chat = buildChat(thread, identity, messages, selfPk)
    const previousChat = runtime.chatSnapshots.get(identity.jid)
    runtime.chatSnapshots.set(identity.jid, chat)
    if (!previousChat) out.chats.push(chat)
    else {
      const diff = diffObject(previousChat, chat)
      if (Object.keys(diff).length) out.chatUpdates.push({ id: identity.jid, ...diff })
    }

    for (const user of thread.users ?? []) {
      const contact = buildContact(user)
      const previous = runtime.contactSnapshots.get(contact.id)
      runtime.contactSnapshots.set(contact.id, contact)
      if (!previous) out.contacts.push(contact)
      else {
        const diff = diffObject(previous, contact)
        if (Object.keys(diff).length) out.contactUpdates.push({ id: contact.id, ...diff })
      }
    }

    if (identity.isGroup) {
      const group = buildGroup(thread, identity.jid, selfPk)
      const previous = runtime.groupSnapshots.get(identity.jid)
      runtime.groupSnapshots.set(identity.jid, group)
      if (!previous) out.groupsUpsert.push(group)
      else {
        if (previous.subject !== group.subject) out.groupsUpdate.push({ id: group.id, subject: group.subject })
        const before = new Map(previous.participants.map((p) => [p.id, p.admin]))
        const after = new Map(group.participants.map((p) => [p.id, p.admin]))
        const added = [...after.keys()].filter((id) => !before.has(id))
        const left = [...before.keys()].filter((id) => !after.has(id))
        const promoted = [...after.keys()].filter((id) => before.has(id) && !before.get(id) && after.get(id))
        const demoted = [...after.keys()].filter((id) => before.has(id) && before.get(id) && !after.get(id))
        for (const [action, list] of [['add', added], ['remove', left], ['promote', promoted], ['demote', demoted]]) {
          if (list.length) out.participants.push({ id: group.id, participants: list, action })
        }
      }
    }
  }

  const emitOut = (out, { initial }) => {
    const selfContact = runtime.user ? { id: runtime.user.id, name: runtime.user.name, notify: runtime.user.username } : null
    ev.buffer()
    try {
      if (initial) {
        if (selfContact && !runtime.contactSnapshots.has(selfContact.id)) {
          runtime.contactSnapshots.set(selfContact.id, selfContact)
          out.contacts.push(selfContact)
        }
        if (out.groupsUpsert.length) ev.emit('groups.upsert', out.groupsUpsert)
        ev.emit('messaging-history.set', {
          chats: out.chats,
          contacts: out.contacts,
          messages: out.history.sort((a, b) => a.messageTimestamp - b.messageTimestamp),
          isLatest: true,
          syncType: 'INITIAL_BOOTSTRAP'
        })
      } else {
        if (out.chats.length) ev.emit('chats.upsert', out.chats)
        if (out.contacts.length) ev.emit('contacts.upsert', out.contacts)
        if (out.groupsUpsert.length) ev.emit('groups.upsert', out.groupsUpsert)
        if (out.history.length) {
          ev.emit('messaging-history.set', { chats: [], contacts: [], messages: out.history, isLatest: false })
        }
      }
      if (out.chatUpdates.length) ev.emit('chats.update', out.chatUpdates)
      if (out.contactUpdates.length) ev.emit('contacts.update', out.contactUpdates)
      if (out.groupsUpdate.length) ev.emit('groups.update', out.groupsUpdate)
      for (const update of out.participants) ev.emit('group-participants.update', update)
      if (out.notify.length) {
        ev.emit('messages.upsert', {
          messages: out.notify.sort((a, b) => a.messageTimestamp - b.messageTimestamp),
          type: 'notify'
        })
      }
      if (out.updates.length) ev.emit('messages.update', out.updates)
      if (out.receipts.length) ev.emit('message-receipt.update', out.receipts)
      if (out.reactions.length) ev.emit('messages.reaction', out.reactions)
      if (out.deletes.length) ev.emit('messages.delete', { keys: out.deletes })
    } finally {
      ev.flush()
    }
  }

  const ingest = async (threads, { initial = false } = {}) => {
    const out = newOut()
    const ordered = [...threads].sort((a, b) => toSeconds(a.last_activity_at) - toSeconds(b.last_activity_at))
    for (const thread of ordered) {
      try {
        await processThread(thread, out, { initial })
      } catch (error) {
        logger.error({ err: error, thread: thread.id }, 'failed to process thread')
      }
    }
    emitOut(out, { initial })
    await persistThreadStates()
  }

  const loginWithCredentials = async () => {
    const credentials = config.credentials
    if (credentials.sessionId) return client.loginBySessionid(credentials.sessionId)
    const { username, password } = credentials
    try {
      return await client.login(username, password)
    } catch (error) {
      if (!(error instanceof TwoFactorRequired)) throw error
      const provider = config.twoFactorCode
      const code = typeof provider === 'function' ? await provider() : provider
      if (!code) throw new DisconnectError('Two-factor code required', DisconnectReason.loggedOut, { twoFactor: true })
      return client.login(username, password, { verificationCode: String(code) })
    }
  }

  const establishSession = async () => {
    const hasCredentials = Boolean(config.credentials) && config.autoLogin
    let isNewLogin = false
    let account = null
    if (client.userId) {
      try {
        account = await client.accountInfo()
      } catch (error) {
        if (error instanceof LoginRequired && hasCredentials) {
          await loginWithCredentials()
          isNewLogin = true
        } else throw error
      }
    } else if (hasCredentials) {
      await loginWithCredentials()
      isNewLogin = true
    } else {
      throw new DisconnectError('Login required: provide credentials or a stored session', DisconnectReason.loggedOut)
    }
    account ??= await client.accountInfo()
    return { account, isNewLogin }
  }

  const fatalFrom = (error) => {
    if (error instanceof DisconnectError) return error
    if (error instanceof BadPassword || error instanceof BadCredentials) {
      return new DisconnectError(error.message || 'Bad credentials', DisconnectReason.loggedOut, error)
    }
    if (error instanceof TwoFactorRequired) {
      return new DisconnectError('Two-factor code required', DisconnectReason.loggedOut, error)
    }
    if (error instanceof ChallengeRequired) {
      return new DisconnectError('Instagram requires a challenge (manual verification)', DisconnectReason.challengeRequired, error)
    }
    if (error instanceof AccountSuspended) {
      return new DisconnectError('Account suspended', DisconnectReason.forbidden, error)
    }
    if (error instanceof LoginRequired) {
      return new DisconnectError('Session expired', DisconnectReason.loggedOut, error)
    }
    return null
  }

  const backoffFor = (error) => {
    const throttled = THROTTLE_ERRORS.some((type) => error instanceof type)
    const base = throttled ? 60000 : 5000
    const cap = throttled ? config.maxBackoffMs : 120000
    return Math.min(base * 2 ** Math.min(runtime.failures, 8), cap)
  }

  const pollOnce = async () => {
    runtime.pollCount += 1
    const [threads] = await client.directThreadsChunk({ threadMessageLimit: config.messageLimit })
    let pending = []
    if (config.pendingPollEvery && runtime.pollCount % config.pendingPollEvery === 0) {
      ;[pending] = await client.directPendingChunk()
    }
    await ingest([...threads, ...pending])
    syncSettings()
  }

  const nextDelay = () => {
    const jitter = 1 + (Math.random() * 2 - 1) * config.pollJitter
    return Math.max(1000, Math.round(config.pollIntervalMs * jitter))
  }

  const tick = async () => {
    if (runtime.closed) return
    try {
      await pollOnce()
      if (runtime.degraded) {
        runtime.degraded = false
        ev.emit('connection.update', { connection: 'open' })
      }
      runtime.failures = 0
      runtime.timer = setTimeout(tick, nextDelay())
    } catch (error) {
      if (error instanceof LoginRequired && config.credentials && config.autoLogin) {
        try {
          await loginWithCredentials()
          syncSettings()
          runtime.timer = setTimeout(tick, 1000)
          return
        } catch (loginError) {
          const fatal = fatalFrom(loginError)
          if (fatal) return close(fatal)
        }
      }
      const fatal = fatalFrom(error)
      if (fatal) return close(fatal)
      runtime.failures += 1
      const delay = backoffFor(error)
      logger.warn({ err: error, retryInMs: delay }, 'poll failed')
      if (!runtime.degraded) {
        runtime.degraded = true
        ev.emit('connection.update', { connection: 'connecting' })
      }
      runtime.timer = setTimeout(tick, delay)
    }
  }

  const start = async () => {
    ev.emit('connection.update', { connection: 'connecting', receivedPendingNotifications: false })
    let session = null
    while (!runtime.closed && !session) {
      try {
        session = await establishSession()
      } catch (error) {
        const fatal = fatalFrom(error)
        if (fatal) return close(fatal)
        runtime.failures += 1
        const delay = backoffFor(error)
        logger.warn({ err: error, retryInMs: delay }, 'connect failed')
        await sleep(delay)
      }
    }
    if (runtime.closed) return
    runtime.failures = 0
    runtime.account = session.account
    runtime.user = {
      id: userJid(session.account.pk),
      pk: String(session.account.pk),
      name: session.account.full_name || session.account.username,
      username: session.account.username
    }
    client.username ??= session.account.username
    updateCreds({
      me: { id: runtime.user.id, name: runtime.user.name, username: runtime.user.username },
      registered: true
    })
    syncSettings()
    runtime.connected = true
    ev.emit('connection.update', { connection: 'open', isNewLogin: session.isNewLogin })
    try {
      const threads = await client.directThreads(config.historyLimit, { threadMessageLimit: config.messageLimit })
      let pending = []
      try {
        ;[pending] = await client.directPendingChunk()
      } catch (error) {
        logger.debug({ err: error }, 'pending inbox unavailable')
      }
      await ingest([...threads, ...pending], { initial: true })
    } catch (error) {
      const fatal = fatalFrom(error)
      if (fatal) return close(fatal)
      logger.warn({ err: error }, 'initial sync failed')
    }
    ev.emit('connection.update', { receivedPendingNotifications: true })
    runtime.timer = setTimeout(tick, nextDelay())
  }

  Object.assign(runtime, {
    updateCreds,
    syncSettings,
    close,
    getThreadState,
    markDirty,
    persistThreadStates,
    selfIdentity,
    ingest,
    chatIdentity,
    contextFor,
    buildGroup,
    buildChat,
    buildContact
  })

  const api = buildSocketApi(runtime)
  Promise.resolve().then(start)
  return api
}
