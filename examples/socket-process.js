import { getMessageText, makeIGSocket, useMultiFileAuthState } from '../src/index.js'

const { state, saveCreds } = await useMultiFileAuthState('./auth_info_ig')
const sock = makeIGSocket({ auth: state, credentials: { sessionId: process.env.IG_SESSIONID } })

sock.ev.process(async (events) => {
  if (events['creds.update']) await saveCreds()

  if (events['messaging-history.set']) {
    const { chats, messages } = events['messaging-history.set']
    console.log(`Riwayat: ${chats.length} chat, ${messages.length} pesan`)
  }

  if (events['messages.upsert']) {
    const { messages, type } = events['messages.upsert']
    for (const msg of messages) console.log(type, msg.key.remoteJid, getMessageText(msg.message))
  }

  if (events['groups.update']) console.log('Grup berubah', events['groups.update'])
  if (events['chats.update']) console.log('Chat berubah', events['chats.update'])
})
