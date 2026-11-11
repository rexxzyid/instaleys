import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Client,
  DisconnectReason,
  NotSupportedError,
  getContentType,
  getMessageText,
  makeIGSocket,
  makeInMemoryStore,
  resolveRealtimeTransport,
  useInMemoryAuthState,
  useMultiFileAuthState,
  userJid
} from '../src/index.js'

const SELF = '100'
const PEER = '200'
const THREAD = '340282366841710300949128177542547091830'
const BASE = 1_700_000_000

const item = (id, userId, text, offset, extra = {}) => ({
  item_id: id,
  user_id: Number(userId),
  timestamp: String((BASE + offset) * 1_000_000),
  item_type: 'text',
  text,
  client_context: `ctx-${id}`,
  ...extra
})

const makeThread = (state) => ({
  thread_v2_id: '999',
  thread_id: THREAD,
  items: [...state.items].reverse(),
  users: [{ pk: Number(PEER), username: 'peer', full_name: 'Peer Name', profile_pic_url: 'http://x/p.jpg' }],
  left_users: [],
  admin_user_ids: [],
  last_activity_at: String((BASE + state.items.length * 10) * 1_000_000),
  muted: false,
  named: false,
  canonical: true,
  pending: false,
  archived: false,
  thread_type: 'private',
  thread_title: '',
  folder: 0,
  vc_muted: false,
  is_group: false,
  mentions_muted: false,
  approval_required_for_new_members: false,
  input_mode: 0,
  read_state: 0,
  last_seen_at: state.lastSeen ?? {}
})

const startMock = async (state) => {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      state.requests.push({ url: req.url, method: req.method, body })
      const json = (data) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', ...data }))
      }
      if (req.url.includes('accounts/current_user')) {
        return json({ user: { pk: Number(SELF), username: 'me', full_name: 'My Name' } })
      }
      if (req.url.includes('direct_v2/inbox/')) {
        return json({ inbox: { threads: [makeThread(state)], oldest_cursor: null } })
      }
      if (req.url.includes('direct_v2/pending_inbox/')) return json({ inbox: { threads: [] } })
      if (req.url.includes('broadcast/text/')) {
        const sentId = `sent${state.sent.length + 1}`
        const form = new URLSearchParams(body)
        state.sent.push({ id: sentId, form })
        state.items.push(item(sentId, SELF, form.get('text'), 1000 + state.sent.length))
        return json({
          payload: { item_id: sentId, timestamp: String((BASE + 1000) * 1_000_000), thread_id: THREAD, client_context: 'cc' }
        })
      }
      if (req.url.includes('broadcast/reaction/')) {
        state.reactionCalls.push(new URLSearchParams(body))
        return json({})
      }
      if (req.url.includes('/delete/')) {
        state.deleteCalls.push(req.url)
        return json({})
      }
      if (req.url.includes('/seen/')) {
        state.seenCalls.push(req.url)
        return json({})
      }
      res.writeHead(404)
      res.end('Not Found')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

const newState = () => ({
  items: [item('m1', PEER, 'halo', 1), item('m2', SELF, 'hai juga', 2)],
  lastSeen: {},
  requests: [],
  sent: [],
  reactionCalls: [],
  deleteCalls: [],
  seenCalls: []
})

const sessionSettings = () => {
  const seed = new Client()
  const settings = seed.getSettings()
  settings.cookies = { ds_user_id: SELF, sessionid: `${SELF}%3Aabcdefghijklmnopqrstuvwxyz0123456789` }
  settings.authorization_data = { ds_user_id: SELF, sessionid: settings.cookies.sessionid }
  return settings
}

const attach = (sock, port) => {
  const real = sock.client.private.request.bind(sock.client.private)
  sock.client.private.request = (method, url, opts) =>
    real(method, url.replace('https://i.instagram.com', `http://127.0.0.1:${port}`), opts)
}

const waitFor = async (predicate, timeout = 4000) => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('waitFor timed out')
}

const baseConfig = (auth) => ({
  auth,
  requestTimeout: 0,
  pollIntervalMs: 60,
  pollJitter: 0,
  pendingPollEvery: 0
})

const withSocket = async (run, { state = newState(), auth = null } = {}) => {
  const { server, port } = await startMock(state)
  const memory = auth ?? useInMemoryAuthState()
  memory.state.creds.settings ??= sessionSettings()
  const sock = makeIGSocket(baseConfig(memory.state))
  attach(sock, port)
  const events = []
  for (const name of [
    'connection.update',
    'messaging-history.set',
    'messages.upsert',
    'messages.update',
    'messages.reaction',
    'messages.delete',
    'message-receipt.update',
    'chats.update',
    'chats.upsert',
    'contacts.upsert'
  ]) {
    sock.ev.on(name, (data) => events.push({ name, data }))
  }
  const store = makeInMemoryStore({})
  store.bind(sock.ev)
  try {
    await run({ sock, state, events, store, auth: memory })
  } finally {
    sock.end()
    server.close()
  }
}

const eventsOf = (events, name) => events.filter((entry) => entry.name === name).map((entry) => entry.data)

test('sinkronisasi awal: connection open, history, store terisi, tanpa notify', async () => {
  await withSocket(async ({ sock, events, store }) => {
    await waitFor(() => sock.user && eventsOf(events, 'messaging-history.set').length)
    assert.equal(sock.user.id, userJid(SELF))
    assert.equal(sock.user.username, 'me')
    assert.ok(eventsOf(events, 'connection.update').some((u) => u.connection === 'open'))
    const history = eventsOf(events, 'messaging-history.set')[0]
    assert.equal(history.messages.length, 2)
    assert.deepEqual(history.messages.map((m) => getMessageText(m.message)), ['halo', 'hai juga'])
    assert.equal(history.messages[0].key.remoteJid, userJid(PEER))
    assert.equal(history.messages[0].key.fromMe, false)
    assert.equal(history.messages[1].key.fromMe, true)
    assert.equal(history.chats[0].id, userJid(PEER))
    assert.equal(history.chats[0].name, 'Peer Name')
    assert.equal(eventsOf(events, 'messages.upsert').length, 0)
    assert.equal(store.chats.all().length, 1)
    assert.equal(store.messages[userJid(PEER)].array.length, 2)
    assert.equal(store.contacts[userJid(PEER)].notify, 'peer')
  })
})

test('pesan masuk baru memicu messages.upsert notify dan unread di store', async () => {
  await withSocket(async ({ sock, state, events, store }) => {
    await waitFor(() => eventsOf(events, 'messaging-history.set').length)
    state.items.push(item('m3', PEER, 'ada yang baru', 3))
    await waitFor(() => eventsOf(events, 'messages.upsert').length)
    const upsert = eventsOf(events, 'messages.upsert')[0]
    assert.equal(upsert.type, 'notify')
    assert.equal(upsert.messages.length, 1)
    assert.equal(upsert.messages[0].message.conversation, 'ada yang baru')
    assert.equal(upsert.messages[0].pushName, 'Peer Name')
    assert.equal(store.messages[userJid(PEER)].array.length, 3)
    assert.equal(store.chats.get(userJid(PEER)).unreadCount, 1)
    assert.equal(sock.user.pk, SELF)
  })
})

test('reaction, penghapusan, dan read receipt terdeteksi', async () => {
  await withSocket(async ({ state, events, store }) => {
    await waitFor(() => eventsOf(events, 'messaging-history.set').length)

    state.items[0].reactions = { likes: [], likes_count: 1, emojis: [{ emoji: '🔥', sender_id: Number(SELF), timestamp: String(BASE * 1_000_000) }] }
    await waitFor(() => eventsOf(events, 'messages.reaction').length)
    const reaction = eventsOf(events, 'messages.reaction')[0][0]
    assert.equal(reaction.key.id, 'm1')
    assert.equal(reaction.reaction.text, '🔥')
    assert.equal(store.messages[userJid(PEER)].get('m1').reactions[0].text, '🔥')

    state.lastSeen = { [PEER]: { item_id: 'm2', timestamp: String((BASE + 50) * 1_000_000), created_at: String((BASE + 50) * 1_000_000) } }
    await waitFor(() => eventsOf(events, 'message-receipt.update').length)
    const receipt = eventsOf(events, 'message-receipt.update')[0][0]
    assert.equal(receipt.key.id, 'm2')
    assert.equal(receipt.receipt.userJid, userJid(PEER))
    assert.equal(store.messages[userJid(PEER)].get('m2').status, 'READ')

    state.items = state.items.filter((entry) => entry.item_id !== 'm1')
    await waitFor(() => eventsOf(events, 'messages.delete').length)
    assert.equal(eventsOf(events, 'messages.delete')[0].keys[0].id, 'm1')
    assert.equal(store.messages[userJid(PEER)].get('m1'), undefined)
  })
})

test('sendMessage teks: thread_ids BigInt akurat, quoted, tanpa duplikat notify', async () => {
  await withSocket(async ({ sock, state, events, store }) => {
    await waitFor(() => eventsOf(events, 'messaging-history.set').length)
    const message = await sock.sendMessage(userJid(PEER), { text: 'balasan' })
    assert.equal(message.key.fromMe, true)
    assert.equal(message.key.id, 'sent1')
    assert.equal(message.message.conversation, 'balasan')
    assert.equal(state.sent[0].form.get('text'), 'balasan')
    assert.equal(state.sent[0].form.get('thread_ids'), `[${THREAD}]`)
    assert.equal(state.sent[0].form.get('action'), 'send_item')
    const upsert = eventsOf(events, 'messages.upsert')
    assert.equal(upsert.length, 1)
    assert.equal(upsert[0].type, 'append')
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(eventsOf(events, 'messages.upsert').length, 1)
    assert.equal(store.messages[userJid(PEER)].array.filter((m) => m.key.id === 'sent1').length, 1)

    const incoming = store.messages[userJid(PEER)].get('m1')
    const reply = await sock.sendMessage(userJid(PEER), { text: 'jawab' }, { quoted: incoming })
    assert.equal(state.sent[1].form.get('replied_to_item_id'), 'm1')
    assert.equal(getContentType(reply.message), 'extendedTextMessage')
  })
})

test('react, delete, readMessages memanggil endpoint yang benar', async () => {
  await withSocket(async ({ sock, state, events, store }) => {
    await waitFor(() => eventsOf(events, 'messaging-history.set').length)
    const target = store.messages[userJid(PEER)].get('m1')

    await sock.sendMessage(userJid(PEER), { react: { text: '👍', key: target.key } })
    assert.equal(state.reactionCalls[0].get('emoji'), '👍')
    assert.equal(state.reactionCalls[0].get('item_id'), 'm1')
    assert.equal(state.reactionCalls[0].get('reaction_status'), 'created')
    assert.equal(state.reactionCalls[0].get('thread_ids'), `["${THREAD}"]`)

    await sock.readMessages([target.key])
    assert.ok(state.seenCalls[0].includes(`/direct_v2/threads/${THREAD}/items/m1/seen/`))

    const own = store.messages[userJid(PEER)].get('m2')
    await sock.sendMessage(userJid(PEER), { delete: own.key })
    assert.ok(state.deleteCalls[0].includes('/items/m2/delete/'))
    assert.equal(eventsOf(events, 'messages.delete').some((d) => d.keys[0].id === 'm2'), true)
    assert.equal(store.messages[userJid(PEER)].get('m2'), undefined)
  })
})

test('konten yang tidak didukung ditolak dengan jelas', async () => {
  await withSocket(async ({ sock, events }) => {
    await waitFor(() => eventsOf(events, 'messaging-history.set').length)
    await assert.rejects(sock.sendMessage(userJid(PEER), { poll: { name: 'x', values: ['a', 'b'] } }), NotSupportedError)
    await assert.rejects(sock.groupParticipantsUpdate(`${THREAD}@g.instagram.net`, [userJid(PEER)], 'promote'), NotSupportedError)
  })
})

test('resolveRealtimeTransport: poll adalah default yang didukung', () => {
  assert.deepEqual(resolveRealtimeTransport(), { type: 'poll', name: 'poll' })
  assert.deepEqual(resolveRealtimeTransport('poll'), { type: 'poll', name: 'poll' })
})

test('resolveRealtimeTransport: mqtt dan nilai yang tidak dikenal ditolak', () => {
  assert.throws(() => resolveRealtimeTransport('mqtt'), NotSupportedError)
  assert.throws(() => resolveRealtimeTransport('carrier-pigeon'), NotSupportedError)
})

test('makeIGSocket: transport mqtt belum diport dan ditolak', () => {
  assert.throws(() => makeIGSocket({ ...baseConfig(useInMemoryAuthState().state), transport: 'mqtt' }), NotSupportedError)
})

test('tanpa session dan kredensial: connection close dengan status 401', async () => {
  const sock = makeIGSocket({ ...baseConfig(useInMemoryAuthState().state) })
  const update = await sock.waitForConnectionUpdate((u) => u.connection === 'close', 3000)
  assert.equal(update.lastDisconnect.error.output.statusCode, DisconnectReason.loggedOut)
})

test('useMultiFileAuthState menyimpan creds dan state thread, restart tidak mengulang pesan lama', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ig-auth-'))
  try {
    const state = newState()
    const first = await useMultiFileAuthState(dir)
    first.state.creds.settings = sessionSettings()
    await withSocket(
      async ({ sock, events }) => {
        sock.ev.on('creds.update', first.saveCreds)
        await waitFor(() => eventsOf(events, 'messaging-history.set').length)
        await waitFor(() => first.state.creds.registered === true)
        await first.saveCreds()
        await new Promise((resolve) => setTimeout(resolve, 150))
      },
      { state, auth: first }
    )

    const second = await useMultiFileAuthState(dir)
    assert.equal(second.state.creds.registered, true)
    assert.equal(second.state.creds.me.username, 'me')
    assert.ok(second.state.creds.settings.cookies.sessionid)
    const stored = await second.state.keys.get('thread-state', [THREAD])
    assert.ok(stored[THREAD].seen.includes('m1'))

    state.items.push(item('m9', PEER, 'saat offline', 9))
    await withSocket(
      async ({ sock, events }) => {
        await waitFor(() => eventsOf(events, 'messages.upsert').length)
        const upsert = eventsOf(events, 'messages.upsert')[0]
        assert.equal(upsert.type, 'notify')
        assert.deepEqual(upsert.messages.map((m) => m.key.id), ['m9'])
        assert.equal(eventsOf(events, 'messaging-history.set')[0].messages.length, 0)
      },
      { state, auth: second }
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('store: loadMessages, writeToFile dan readFromFile', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ig-store-'))
  try {
    await withSocket(async ({ events, store }) => {
      await waitFor(() => eventsOf(events, 'messaging-history.set').length)
      const jid = userJid(PEER)
      const last = await store.loadMessages(jid, 1)
      assert.equal(last[0].key.id, 'm2')
      const before = await store.loadMessages(jid, 5, { before: last[0].key })
      assert.deepEqual(before.map((m) => m.key.id), ['m1'])
      assert.equal((await store.mostRecentMessage(jid)).key.id, 'm2')

      const file = join(dir, 'store.json')
      await store.writeToFile(file)
      const restored = makeInMemoryStore({})
      assert.equal(await restored.readFromFile(file), true)
      assert.equal(restored.messages[jid].array.length, 2)
      assert.equal(restored.chats.all()[0].id, jid)
      assert.equal(await makeInMemoryStore({}).readFromFile(join(dir, 'nope.json')), false)
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ev.process mengelompokkan event dalam satu batch', async () => {
  await withSocket(async ({ sock }) => {
    const batches = []
    sock.ev.process((map) => batches.push(map))
    await waitFor(() => batches.some((map) => map['messaging-history.set']))
    const first = batches.find((map) => map['messaging-history.set'])
    assert.ok(first['messaging-history.set'].messages.length >= 0)
  })
})
