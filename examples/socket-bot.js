import {
  DisconnectReason,
  getMessageText,
  makeIGSocket,
  makeInMemoryStore,
  useMultiFileAuthState
} from '../src/index.js'

const store = makeInMemoryStore({ maxMessagesPerChat: 500 })
await store.readFromFile('./ig_store.json')
setInterval(() => store.writeToFile('./ig_store.json'), 30000).unref()

const connect = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_ig')

  const sock = makeIGSocket({
    auth: state,
    credentials: process.env.IG_USERNAME
      ? { username: process.env.IG_USERNAME, password: process.env.IG_PASSWORD }
      : null,
    twoFactorCode: () => process.env.IG_2FA,
    proxy: process.env.IG_PROXY || null,
    pollIntervalMs: 10000
  })

  store.bind(sock.ev)
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, receivedPendingNotifications }) => {
    if (connection === 'open') console.log(`Terhubung sebagai @${sock.user.username}`)
    if (receivedPendingNotifications) console.log('Sinkronisasi awal selesai')
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      console.log('Terputus:', lastDisconnect?.error?.message, code)
      if (code !== DisconnectReason.loggedOut && code !== DisconnectReason.challengeRequired) {
        setTimeout(connect, 5000)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue
      const jid = msg.key.remoteJid
      const text = getMessageText(msg.message).trim()
      console.log(`[${msg.pushName}] ${text}`)

      if (text === '!ping') {
        await sock.sendMessage(jid, { text: 'pong' }, { quoted: msg })
      } else if (text === '!like') {
        await sock.sendMessage(jid, { react: { text: '❤️', key: msg.key } })
      } else if (text.startsWith('!info ')) {
        const user = await sock.instagram.userInfo(text.slice(6).trim())
        await sock.sendMessage(jid, {
          text: `@${user.username}\n${user.full_name}\nFollowers: ${user.follower_count}\nPost: ${user.media_count}`
        })
      } else if (text === '!foto') {
        await sock.sendMessage(jid, { image: { url: 'https://picsum.photos/800/600.jpg' } })
      }
      await sock.readMessages([msg.key])
    }
  })

  sock.ev.on('messages.reaction', (items) => {
    for (const { key, reaction } of items) console.log('Reaksi', reaction.text || '(dihapus)', 'pada', key.id)
  })

  sock.ev.on('message-receipt.update', (items) => {
    for (const { key, receipt } of items) console.log('Dibaca oleh', receipt.userJid, 'pesan', key.id)
  })

  sock.ev.on('messages.delete', ({ keys }) => console.log('Pesan dihapus:', keys.map((k) => k.id)))
}

await connect()
