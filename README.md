# instaleys

Port Node.js dari klien Instagram Private API dengan dua lapisan:

1. `Client`: klien Instagram Private API (setara `instaleys.Client`).
2. `makeIGSocket`: API bergaya Baileys (`sock.ev`, `useMultiFileAuthState`, `makeInMemoryStore`) di atas `Client`.

Butuh Node.js 18.17+. Dependensi: `undici`. Opsional: `sharp` (konversi foto non-JPEG saat kirim gambar).

```bash
npm install
npm run verify
```

Untuk kontributor: baca `AGENTS.md` sebelum mengubah kode.

## Mulai cepat (gaya Baileys)

```js
import { makeIGSocket, makeInMemoryStore, useInMemoryAuthState, getMessageText, DisconnectReason } from 'instaleys'

const store = makeInMemoryStore({})
const { state, saveCreds } = await useMultiFileAuthState('auth_info_ig')

const sock = makeIGSocket({
  auth: state,
  credentials: { username: 'user', password: 'pass' },
  twoFactorCode: () => process.env.IG_2FA,
  proxy: 'http://user:pass@host:port'
})

store.bind(sock.ev)
sock.ev.on('creds.update', saveCreds)

sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
  if (connection === 'open') console.log('Terhubung', sock.user.username)
  if (connection === 'close') {
    const code = lastDisconnect.error?.output?.statusCode
    if (code !== DisconnectReason.loggedOut) console.log('Buat ulang socket')
  }
})

sock.ev.on('messages.upsert', async ({ messages, type }) => {
  if (type !== 'notify') return
  for (const msg of messages) {
    if (msg.key.fromMe) continue
    await sock.sendMessage(msg.key.remoteJid, { text: `Kamu: ${getMessageText(msg.message)}` }, { quoted: msg })
  }
})
```

Login bisa lewat `credentials: { username, password }`, `credentials: { sessionId }`, atau session yang sudah tersimpan di `auth`. Contoh lengkap ada di folder `examples/`.

## JID

| Jenis | Format |
|---|---|
| Pengguna / chat pribadi | `<pk>@s.instagram.net` |
| Grup | `<thread_id>@g.instagram.net` |

Helper: `userJid`, `groupJid`, `jidDecode`, `jidEncode`, `isJidUser`, `isJidGroup`, `jidNormalizedUser`. `sock.resolveJid('username')` mengubah username jadi JID.

## Cara kerja dan batasan penting

Instagram tidak punya WebSocket publik seperti WhatsApp. Port ini **polling inbox** tiap `pollIntervalMs` (default 10 detik, dengan jitter), lalu membandingkan dengan state sebelumnya untuk menghasilkan event. Artinya:

- Pesan masuk tertunda sampai satu interval polling. Realtime MQTT belum diport. Opsi `transport` pada `makeIGSocket` mendukung `'poll'` (default) dan akan mendukung `'mqtt'` setelah port realtime selesai. Nilai lain melempar `NotSupportedError`.
- Jangan menurunkan interval terlalu agresif; Instagram membatasi request. Saat terkena throttle, socket otomatis backoff dan mengirim `connection: 'connecting'` lalu `'open'` ketika pulih.
- State per thread (id pesan yang sudah dilihat) disimpan lewat `auth.keys` (`thread-state`), sehingga setelah restart hanya pesan yang masuk saat offline yang dikirim sebagai `notify`.
- `chatModify({ archive })` dan `{ delete }` keduanya memakai endpoint `hide` milik Instagram.
- Status `READ` dihitung dari `last_seen_at` thread (di grup: dibaca oleh minimal satu orang).
- `sendPresenceUpdate` adalah no-op (tidak ada endpoint indikator mengetik).

## Realtime transport

`makeIGSocket` membaca opsi `transport` dari konfigurasi socket:

```js
const sock = makeIGSocket({ transport: 'poll' })
```

- `'poll'` (default): polling inbox lewat `direct_v2/inbox/`, seperti sebelumnya.
- `'mqtt'`: menunjuk ke realtime MQTT milik Instagram (klien `RealtimeClient` dan `FbnsClient` dari `instaleys/realtime`), belum diport ke Node. `makeIGSocket` dengan `transport: 'mqtt'` melempar `NotSupportedError` sampai port hadir.

Helper `resolveRealtimeTransport` diekspor untuk validasi nilai transport. Custom transport masih menunggu port MQTT stabil dari sisi protokol.

## Event

`connection.update`, `creds.update`, `messaging-history.set`, `messages.upsert` (`notify` / `append`), `messages.update`, `messages.delete`, `messages.reaction`, `message-receipt.update`, `chats.upsert`, `chats.update`, `chats.delete`, `contacts.upsert`, `contacts.update`, `groups.upsert`, `groups.update`, `group-participants.update`, `presence.update`.

`sock.ev` mendukung `on`, `once`, `off`, `removeAllListeners`, `process(handler)` (batch semua event dalam satu tick), `buffer()`/`flush()`, `createBufferedFunction`.

## Method socket

| Kelompok | Method |
|---|---|
| Kirim | `sendMessage(jid, content, { quoted })` |
| Baca / chat | `readMessages(keys)`, `chatModify({ mute \| markRead \| archive \| delete \| spam \| approve }, jid)`, `fetchMessageHistory(jid, count)` |
| Presence | `presenceSubscribe(jid)`, `fetchActivePresence()` |
| Kontak | `onInstagram(...usernames)` (alias `onWhatsApp`), `fetchStatus`, `profilePictureUrl`, `getBusinessProfile`, `updateBlockStatus`, `searchUsers` |
| Grup | `groupMetadata`, `groupFetchAllParticipating`, `groupCreate`, `groupUpdateSubject`, `groupParticipantsUpdate(jid, ids, 'add')` |
| Request pesan | `fetchMessageRequests`, `acceptMessageRequest`, `fetchSpamInbox` |
| Akun | `updateProfileStatus`, `updateProfileName`, `refreshSession`, `logout`, `end` |
| Util | `waitForConnectionUpdate(check, timeout)`, `resolveJid` |

### `sendMessage` content

```js
{ text: 'halo' }
{ text: 'balas', }, { quoted: msg }
{ react: { text: '🔥', key: msg.key } }
{ react: { text: '', key: msg.key, previous: '🔥' } }
{ delete: msg.key }
{ image: { url } }      // Buffer, path, URL, atau { url | path | stream }
{ video: buffer }       // MP4
{ audio: buffer }       // dikirim sebagai voice note
{ mediaShare: { mediaId, type: 'photo' | 'video' } }
{ storyShare: { storyId } }
{ profile: { userId } }
{ forward: msg }
```

Foto/video/voice ke chat pribadi membutuhkan thread yang sudah ada. `caption` pada gambar dikirim sebagai pesan teks terpisah. Konten yang tidak didukung Instagram (`poll`, `location`, `contacts`, `buttons`, `sticker`, `document`, `edit`) melempar `NotSupportedError`. Aksi grup selain `add` dan `groupLeave` juga belum tersedia karena endpoint-nya tidak ada di klien asli.

### Format pesan

```js
{
  key: { remoteJid, fromMe, id, participant, threadId },
  message: { conversation } | { extendedTextMessage } | { imageMessage } | { videoMessage } |
           { audioMessage } | { stickerMessage } | { mediaShareMessage } | { reelShareMessage } |
           { storyShareMessage } | { profileMessage } | { locationMessage } | { reactionMessage } | ...,
  messageTimestamp, pushName, status, reactions
}
```

Helper: `getContentType`, `normalizeMessageContent`, `getMessageText`, `downloadMediaMessage(msg, 'buffer' | 'stream')`.

## Auth state

- `useMultiFileAuthState(folder)` mengembalikan `{ state, saveCreds }`. `creds.json` berisi session (cookie, token, device, UUID) dan file `thread-state-<id>.json` menyimpan posisi sinkronisasi. File ditulis dengan izin `0600` dan secara atomik. Jaga folder ini seperti password.
- `useInMemoryAuthState()` untuk tes.

## Store

`makeInMemoryStore({ maxMessagesPerChat })` dengan `bind(ev)`, `chats` (`all`, `get`, ...), `contacts`, `messages[jid]` (`array`, `get`, ...), `groupMetadata`, `presences`, `state`, `loadMessages(jid, count, { before: key })`, `loadMessage`, `mostRecentMessage`, `fetchImageUrl`, `fetchGroupMetadata`, `toJSON`/`fromJSON`, `writeToFile`/`readFromFile`.

## Fitur Instagram di luar chat

`sock.instagram` menerima username, pk, atau JID: `userInfo`, `followers`, `following`, `medias`, `clips`, `stories`, `follow`, `unfollow`, `block`, `unblock`, `closeFriendAdd/Remove`, `followRequests`, `like`/`unlike`, `comment`, `comments`, `commentReplies`, `likeComment`, `deleteComments`, `mediaInfo` (menerima URL post), `storySeen`, `storyViewers`, `hashtagInfo`, `hashtagMedias`, `hashtagFollow`, `explore`, `timeline`, `reelsTray`, `editAccount`, `setPrivate`, `setPublic`.

Seluruh `Client` (semua method camelCase hasil port klien asli) juga tersedia di `sock.client`.

## Belum diport

- Login Bloks CAA (`login()` memakai alur legacy `accounts/login/`), challenge resolver otomatis, realtime MQTT.
- Upload post, reel, album, story; download media lewat `Client`.
- Public web/GraphQL API, signup, insights, notes, location, collection, highlight.
- Transport `curl`/`utls` (sidik jari TLS berbeda dari klien Python).
