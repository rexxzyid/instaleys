import { makeIGSocket, useMultiFileAuthState } from '../src/index.js'

const { state, saveCreds } = await useMultiFileAuthState('./auth_info_ig')
const sock = makeIGSocket({ auth: state })
sock.ev.on('creds.update', saveCreds)
await sock.waitForConnectionUpdate((u) => u.connection === 'open', 120000)

const [a, b] = await sock.onInstagram('instagram', 'creators')
const group = await sock.groupCreate('Grup Tes', [a.jid, b.jid])
console.log(group.id, group.subject, group.participants.length)

await sock.groupUpdateSubject(group.id, 'Grup Tes 2')
await sock.sendMessage(group.id, { text: 'Halo semua' })
await sock.chatModify({ mute: true }, group.id)

const all = await sock.groupFetchAllParticipating()
console.log(Object.keys(all))

const history = await sock.fetchMessageHistory(group.id, 20)
console.log(history.length)
