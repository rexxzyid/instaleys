# instaleys

Klien Instagram Private API untuk Node.js 20+, dengan API bergaya Baileys.

```bash
npm install instaleys
```

## Mulai cepat

```js
import { makeIGSocket, makeInMemoryStore, useMultiFileAuthState } from 'instaleys'

const store = makeInMemoryStore({})
const { state, saveCreds } = await useMultiFileAuthState('auth_info_ig')

const sock = makeIGSocket({
  auth: state,
  credentials: { username: 'user', password: 'pass' },
  twoFactorCode: () => process.env.IG_2FA
})

store.bind(sock.ev)
sock.ev.on('creds.update', saveCreds)

sock.ev.on('connection.update', ({ connection }) => {
  if (connection === 'open') console.log('Terhubung sebagai', sock.user.username)
})

sock.ev.on('messages.upsert', async ({ messages, type }) => {
  if (type !== 'notify') return
  for (const message of messages) {
    if (message.key.fromMe) continue
    await sock.sendMessage(message.key.remoteJid, { text: 'Halo' }, { quoted: message })
  }
})
```

Login bisa lewat `credentials: { username, password }`, `credentials: { sessionId }`, atau session yang sudah tersimpan di `auth`.

## Kirim pesan

```js
await sock.sendMessage(jid, { text: 'halo' })
await sock.sendMessage(jid, { image: { url: 'foto.jpg' }, caption: 'halo' })
await sock.sendMessage(jid, { video: buffer })
await sock.sendMessage(jid, { audio: buffer })
await sock.sendMessage(jid, { react: { text: '🔥', key: message.key } })
await sock.sendMessage(jid, { delete: message.key })
await sock.sendMessage(jid, { mediaShare: { mediaId, type: 'photo' } })
await sock.sendMessage(jid, { storyShare: { storyId } })
await sock.sendMessage(jid, { profile: { userId } })
await sock.sendMessage(jid, { forward: message })
```

JID pengguna: `<pk>@s.instagram.net`. JID grup: `<thread_id>@g.instagram.net`.

## Event

`connection.update`, `creds.update`, `messaging-history.set`, `messages.upsert`, `messages.update`, `messages.delete`, `messages.reaction`, `message-receipt.update`, `chats.upsert`, `chats.update`, `chats.delete`, `contacts.upsert`, `contacts.update`, `groups.upsert`, `groups.update`, `group-participants.update`, `presence.update`.

## Method socket

| Kelompok | Method |
|---|---|
| Kirim | `sendMessage` |
| Baca / chat | `readMessages`, `chatModify`, `fetchMessageHistory` |
| Kontak | `onInstagram`, `fetchStatus`, `profilePictureUrl`, `updateBlockStatus`, `searchUsers` |
| Grup | `groupMetadata`, `groupFetchAllParticipating`, `groupCreate`, `groupUpdateSubject`, `groupParticipantsUpdate` |
| Request pesan | `fetchMessageRequests`, `acceptMessageRequest`, `fetchSpamInbox` |
| Akun | `updateProfileStatus`, `updateProfileName`, `refreshSession`, `logout`, `end` |
| Util | `resolveJid`, `waitForConnectionUpdate` |

## Store dan auth state

```js
const store = makeInMemoryStore({ maxMessagesPerChat: 50 })
store.bind(sock.ev)

store.chats.all()
store.messages[jid].array
await store.loadMessages(jid, 20)
await store.writeToFile('store.json')
```

`useMultiFileAuthState(folder)` mengembalikan `{ state, saveCreds }`. Jaga folder `auth_info_ig` seperti password. Untuk tes, pakai `useInMemoryAuthState()`.

## Fitur Instagram lain

`sock.instagram` menerima username, pk, atau JID:

```js
await sock.instagram.userInfo('username')
await sock.instagram.followers('username')
await sock.instagram.medias('username')
await sock.instagram.like(mediaId)
await sock.instagram.comment(mediaId, 'keren')
await sock.instagram.storySeen(storyId)
await sock.instagram.hashtagMedias('travel')
```

Method lain: `following`, `clips`, `stories`, `follow`, `unfollow`, `block`, `unblock`, `closeFriendAdd/Remove`, `followRequests`, `unlike`, `comments`, `commentReplies`, `likeComment`, `deleteComments`, `mediaInfo`, `storyViewers`, `hashtagInfo`, `hashtagFollow`, `explore`, `timeline`, `reelsTray`, `editAccount`, `setPrivate`, `setPublic`.

Semua method `Client` juga tersedia di `sock.client`.

## 2FA TOTP

```js
const seed = await client.totpGenerateSeed()
const backupCodes = await client.totpEnable('123456')
await client.totpDisable()

const code = client.totpGenerateCode(seed)
```

Bisa dipanggil lewat `sock.client` atau instance `Client` langsung.

## Batasan

- Pesan baru dideteksi lewat polling (default 10 detik), bukan realtime. `transport: 'mqtt'` melempar `NotSupportedError`.
- Belum tersedia: login Bloks CAA, challenge resolver otomatis, upload post/reel/story, download media, public/GraphQL, signup, insights, location, dan modul lain di luar yang disebut di atas.
- Semua pengujian memakai server palsu; belum pernah diuji ke Instagram sungguhan.
