# AGENTS.md

Panduan wajib untuk setiap agent AI atau kontributor yang mengubah proyek ini. Baca seluruhnya sebelum menulis kode. Jika aturan di sini bertentangan dengan insting kamu, ikuti aturan ini.

## 1. Proyek ini apa

Port Node.js (ESM, Node >= 18.17) dari library Python `instagrapi` (Instagram Private API, meniru aplikasi Android), dengan dua lapisan:

1. `Client` (`src/client.js`, `src/mixins/*`): port langsung instagrapi.
2. `makeIGSocket` (`src/socket/*`): API bergaya Baileys di atas `Client`. Mendeteksi pesan baru lewat polling inbox, bukan realtime.

Sumber kebenaran tunggal untuk endpoint, parameter, header, dan perilaku adalah kode Python asli (`instagrapi-master/instagrapi/`). Dokumentasi, ingatan, dan library lain BUKAN sumber kebenaran.

## 2. Aturan mutlak

1. **Dilarang menebak.** Endpoint, nama field, parameter, header, nilai default, dan urutan langkah harus dibaca dari sumber Python sebelum ditulis. Dulu endpoint yang ditulis dari ingatan terbukti salah (`SEND_ATTRIBUTES`, comment replies, `set_biography`, `remove_follower`). Jika tidak bisa diverifikasi di sumber, JANGAN implementasikan: lempar `NotSupportedError` dan catat di README bagian "Belum diport".
2. **Dilarang menulis komentar di kode**: tidak ada `//`, `/* */`, JSDoc, atau kode yang dikomentari. Penjelasan hanya boleh di README, AGENTS.md, pesan commit, atau laporan ke pengguna. Dicek otomatis oleh `npm run check`.
3. **Dilarang mengklaim sesuatu berfungsi** hanya karena tes dengan server palsu lolos. Tidak ada akses ke Instagram sungguhan. Laporkan terpisah: apa yang diuji otomatis, apa yang belum pernah dicoba ke server asli.
4. **Dilarang menambah dependensi** tanpa alasan kuat. Saat ini: `undici` (wajib), `sharp` (opsional). Dependensi baru harus dipin versinya dan dijelaskan di README.
5. **Dilarang menghapus atau melemahkan tes** yang ada agar kode baru lolos. Perbaiki kodenya.
6. **Dilarang mengubah perilaku yang sudah ada** (login legacy, format pesan, nama event) tanpa alasan yang terverifikasi di sumber dan tes yang membuktikannya.
7. **Berhenti dan tanyakan** (atau tandai `NotSupportedError`) bila sumber ambigu, bergantung pada binary/ffmpeg yang tidak ada, atau butuh protokol yang tidak ada di repo Python (contoh: MQTT realtime).

## 3. Alur kerja wajib untuk setiap fitur

1. Cari fungsi Python-nya:
   ```bash
   cd /tmp
   python3 /path/ke/instagrapi-node/scripts/pyfn.py /path/ke/instagrapi-master/instagrapi/mixins/direct.py --list
   python3 /path/ke/instagrapi-node/scripts/pyfn.py /path/ke/instagrapi-master/instagrapi/mixins/direct.py direct_thread_mute
   ```
   Jalankan dari direktori LAIN (mis. `/tmp`); menjalankan python dari dalam `instagrapi/` bentrok dengan `types.py` dan merusak modul stdlib.
2. Catat dari sumber: endpoint, method (GET bila `data` kosong, POST bila ada), `with_signature`, `params` vs `data`, tipe tiap nilai, default argumen, error yang diubah menjadi exception.
3. Port persis perilakunya. Tipe model pydantic menjadi objek biasa lewat `src/extractors.js`.
4. Tulis tes (lihat bagian 6).
5. Jalankan `npm run verify`.
6. Perbarui README bila ada fitur atau batasan baru.

## 4. Standar clean code

- Satu fungsi, satu tugas. Fungsi pendek; ekstrak helper bernama jelas, bukan komentar.
- Nama menjelaskan maksud: `requireLogin`, `resolveTarget`, `bigintList`. Hindari singkatan samar.
- Early return dan guard clause; hindari nesting lebih dari 3 tingkat.
- Tidak ada kode mati, kode yang dikomentari, `console.log` sisa debug, atau variabel tak terpakai.
- Tidak ada angka/string ajaib yang dikarang. Konstanta yang meniru Python boleh literal dan harus sama persis dengan sumber. Konstanta buatan sendiri diberi nama (`STATE_LIMIT`).
- Jangan mengubah argumen masuk. Salin dulu (`structuredClone`, spread).
- `async`/`await`; jangan campur dengan rantai `.then` kecuali di titik masuk yang memang butuh.
- Tangani error spesifik. Jangan `catch {}` kosong yang menelan error tak terduga; tangkap kelas error yang dimaksud dan lempar ulang sisanya.
- Impor ESM dengan ekstensi `.js`. Hindari export default kecuali sudah ada polanya.
- Format: tanpa titik koma, kutip tunggal, indentasi 2 spasi, koma akhir tidak dipakai, mengikuti file di sekitarnya.

## 5. Konvensi proyek

- **Penamaan**: snake_case Python menjadi camelCase (`user_info_by_username_v1` menjadi `userInfoByUsernameV1`). Sufiks `V1` dipertahankan.
- **Mixin**: tiap file di `src/mixins/` mengekspor objek method yang digabung ke `Client.prototype` di `src/client.js`. Method baru masuk ke mixin yang sesuai, atau mixin baru yang didaftarkan di `client.js`.
- **Argumen**: argumen wajib posisional, argumen opsional lewat objek (`directSend(text, { userIds, threadIds })`).
- **Request**: `privateRequest(endpoint, data, { params, withSignature, login, headers, domain })`. `data` kosong berarti GET. `withSignature: false` mengirim form-urlencoded; `true` mengirim `signed_body=SIGNATURE.<json>`. Boolean pada `params` dikirim sebagai `True`/`False` seperti Python.
- **ID**: `pk` selalu string. ID thread/pengguna bisa sangat besar: JANGAN gunakan `Number` untuk thread id. Gunakan string atau `BigInt`, dan serialisasi daftar ID manual (`bigintList` di `mixins/direct.js`) karena `JSON.stringify` tidak mendukung `BigInt`.
- **Error**: gunakan hierarki di `src/errors.js`; tambahkan kelas baru hanya bila ada padanannya di `exceptions.py`.
- **Settings**: nilai tersimpan (mis. `request_timeout`) menimpa argumen konstruktor di `init()`. Config eksplisit dari pemanggil harus menang (lihat `socket.js`).
- **Socket**: event dan format pesan mengikuti Baileys (`key`, `message`, `messageTimestamp`). JID pengguna `<pk>@s.instagram.net`, grup `<thread_id>@g.instagram.net`. Fitur yang tidak ada di Instagram melempar `NotSupportedError`, bukan dipalsukan.
- **Rate limit**: jangan menambah request periodik atau loop agresif tanpa jeda dan backoff.

## 6. Pengujian

- Framework: `node:test`. Berkas di `test/*.test.js`.
- Tes jaringan memakai server HTTP lokal dan menimpa `client.private.request` agar `https://i.instagram.com` diarahkan ke `http://127.0.0.1:PORT` (contoh lengkap di `test/socket.test.js`).
- Set `requestTimeout: 0` pada tes agar tidak menunggu 1 detik per request, dan pastikan settings yang dipakai tes juga `request_timeout: 0`.
- Wajib ada tes untuk: body/parameter request yang dikirim (bandingkan dengan sumber Python), pemetaan error, dan perubahan event/store pada socket.
- Fungsi murni (codec, enkripsi, parser) diuji langsung dengan nilai yang diketahui, termasuk uji balik (mis. enkripsi lalu dekripsi).

## 7. Perintah

```bash
npm install
npm run check     # tolak komentar dan karakter tak terlihat
npm test          # seluruh tes
npm run verify    # check + test; wajib hijau sebelum menyerahkan pekerjaan
node --check src/path/ke/file.js
```

Setelah edit besar, periksa juga karakter zero-width yang pernah menyelinap ke nama method: `npm run check` sudah menutupinya.

## 8. Status dan batasan saat ini

Sudah ada: login legacy (+2FA kode, sessionid), account, user, media, comment, story, hashtag, explore, seluruh fitur DM (teks/link, reply, reaction, hapus, foto/video/voice via rupload, share, grup, mute, request/spam inbox, presence), dan lapisan socket (auth state multi-file, store in-memory, event, polling).

Belum ada (jangan pura-pura sudah): login Bloks CAA, challenge resolver, realtime MQTT, upload post/reel/album/story dan download media, public web/GraphQL API, signup, insights, notes, location, collection, highlight, track, transport TLS `curl`/`utls`.

Belum pernah diuji ke Instagram sungguhan: semuanya. Tes otomatis hanya memakai server palsu.

## 9. Backlog berurutan

Kerjakan satu per satu, tiap item selesai penuh (tes + README) sebelum lanjut.

1. **Transport realtime.** Cek dulu apakah ada kode MQTT/realtime di sumber Python (`grep -ri "mqtt\|realtime" instagrapi-master`). Jika tidak ada, jangan mengarang protokol: tambahkan antarmuka `config.transport` ('poll' atau objek custom) dan polling adaptif, lalu laporkan temuan.
2. **Login Bloks CAA** dari `mixins/bloks.py` (+ pemanggil di `auth.py`), bertahap, mulai dari builder/parser murni yang bisa diuji.
3. **Challenge resolver** dari `mixins/challenge.py`, dihubungkan ke `challengeCodeHandler` dan socket.
4. **Upload dan download konten**: photo, video, album, clip, story, serta `download_*`.
5. **Modul lain**: location, collection, highlight, note, track, insights, share, totp, public/graphql.
6. **Penyempurnaan socket**: presence berkala, riwayat dengan cursor, antrean request terpusat, dan perbaikan race kecil antara `sendMessage` dan polling (pesan yang baru dikirim bisa terlihat poll sebelum dicatat sebagai terkirim).

## 10. Definisi selesai

- `npm run verify` hijau.
- Setiap endpoint baru bisa ditunjuk ke fungsi Python asalnya (sebut nama fungsinya di laporan, bukan di kode).
- README memuat fitur baru, batasan, dan apa yang belum diuji ke server asli.
- Tidak ada file sementara, `node_modules`, `session.json`, atau folder `auth_info*` di hasil akhir.

## 11. Format laporan akhir

1. Apa yang dikerjakan (selesai / sebagian / ditolak beserta alasan).
2. Daftar file yang dibuat atau diubah.
3. Keluaran `npm run verify`.
4. Fungsi Python sumber untuk tiap endpoint baru.
5. Keputusan desain yang menyimpang dari Python dan alasannya.
6. Risiko dan hal yang perlu dicoba manual dengan akun asli, disebutkan spesifik.
