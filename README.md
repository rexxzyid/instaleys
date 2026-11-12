# @rexxhayanasi/instaleys

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

## Notes

```js
const notes = await sock.instagram.notes()
sock.client.getNoteTextByUser(notes, 'username')

await sock.instagram.createNote('halo', { audience: 0 })
await sock.instagram.createMusicNote(track, 'lagu')
await sock.instagram.deleteNote(noteId)
await sock.instagram.updateNotesLastSeen()
```

`sock.instagram.notes()` memakai private GraphQL (`graphql/query`). `track` berasal dari `client.notesMusicBrowser()` atau objek lain dengan `audio_cluster_id`.

## Insights (akun bisnis/kreator)

```js
await sock.instagram.insightsAccount()
await sock.instagram.insightsMedia(mediaId)
await sock.instagram.insightsMediaFeedAll({ postType: 'ALL', timeFrame: 'TWO_YEARS', dataOrdering: 'REACH_COUNT', count: 50 })
```

Akun non-bisnis melempar `UserError`.

## Koleksi, reels, lokasi, highlight

```js
await sock.instagram.collections()
await sock.instagram.collectionMedias(collectionPk)
await sock.instagram.saveMedia(mediaId)
await sock.instagram.likedMedias()

await sock.instagram.reels(10)
await sock.instagram.exploreReels(10)
await sock.instagram.friendsReels(10)

await sock.instagram.locationSearch(-6.2, 106.8)
await sock.instagram.locationMedias(locationPk, 63, 'ranked')
await sock.instagram.locationMediasTop(locationPk)
await sock.instagram.locationMediasRecent(locationPk)
await sock.instagram.locationGuides(locationPk)

await sock.instagram.userHighlights('username')
await sock.instagram.highlightInfo(highlightPk)
await sock.instagram.highlightCreate('Judul', [storyId])
await sock.instagram.highlightAddStories(highlightPk, [storyId])
await sock.instagram.highlightRemoveStories(highlightPk, [storyId])
await sock.instagram.highlightDelete(highlightPk)
```

`locationSearchName`, `locationSearchPk`, `locationComplete`, `locationBuild`, dan `shareInfo` sisi publik belum diport karena butuh public web API. `locationMediasTop`/`Recent` memakai tab `ranked`/`recent`.

## Share code

```js
const info = sock.client.shareInfo('aGlnaGxpsdsdZ2h0OjE3OTg4MDg5NjI5MzgzNzcw')
sock.client.shareCodeFromUrl('https://www.instagram.com/p/ABC123/')
await sock.instagram.shareInfoByUrl('https://www.instagram.com/p/ABC123/')
```

Semua method `Client` juga tersedia di `sock.client`.

## DM langsung via Client

```js
await sock.client.directSend(userId, 'halo')
await sock.client.directSendPhoto(buffer, { userIds: [userId] })
await sock.client.directSendCutoutSticker('123456789', { userIds: [userId] })
await sock.client.directMediaShare(mediaId, { userIds: [userId] })
```

Method DM lain: `directSendFile`, `directSendVideo`, `directSendVoice`, `directThreadMute`, `directThreadCreate`, `directThreadAddUsers`, dan lainnya.

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
- Belum tersedia: login Bloks CAA, challenge resolver otomatis, upload post/reel/story, download media, public web API, signup, track, dan modul lain di luar yang disebut di atas.
- `locationSearchName`, `locationSearchPk`, `locationComplete`, dan `locationBuild` tidak diport karena bergantung pada public web API.
- `highlightChangeCover` tidak diport karena butuh upload foto (`photo_rupload`).
- Semua pengujian memakai server palsu; belum pernah diuji ke Instagram sungguhan.
