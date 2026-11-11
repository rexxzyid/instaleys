import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { generateKeyPairSync, privateDecrypt, constants, createDecipheriv } from 'node:crypto'
import {
  Client,
  InstagramIdCodec,
  generateSignature,
  generateJazoest,
  dumps,
  extractMediaV1,
  LoginRequired,
  ClientNotFoundError
} from '../src/index.js'

test('InstagramIdCodec round trip dan nilai dari dokumentasi', () => {
  assert.equal(InstagramIdCodec.encode('2110901750722920960'), 'B1LbfVPlwIA')
  assert.equal(String(InstagramIdCodec.decode('B1LbfVPlwIA')), '2110901750722920960')
  assert.equal(String(InstagramIdCodec.decode('B-fKL9qpeab')), '2278584739065882267')
})

test('generateSignature dan dumps', () => {
  assert.equal(generateSignature('{"a":"b c"}'), 'signed_body=SIGNATURE.%7B%22a%22%3A%22b+c%22%7D')
  assert.equal(dumps({ a: 'é', b: [1, 2] }), '{"a":"\\u00e9","b":[1,2]}')
  assert.equal(generateJazoest('ab'), `2${97 + 98}`)
})

test('mediaPk dan mediaPkFromUrl', () => {
  const client = new Client()
  assert.equal(client.mediaPk('2277033926878261772_1903424587'), '2277033926878261772')
  assert.equal(client.mediaPkFromUrl('https://www.instagram.com/p/B-fKL9qpeab/?igshid=1xm76zkq7o1im'), '2278584739065882267')
  assert.equal(client.mediaCodeFromPk('2110901750722920960'), 'B1LbfVPlwIA')
})

test('settings round trip menjaga uuid dan device', () => {
  const a = new Client()
  const b = new Client({ settings: a.getSettings() })
  assert.equal(a.uuid, b.uuid)
  assert.equal(a.phoneId, b.phoneId)
  assert.equal(a.userAgent, b.userAgent)
  assert.match(a.userAgent, /^Instagram 455\.0\.0\.51\.72 Android \(34\/14; 480dpi; 1344x2992; Google\/google; Pixel 8 Pro; husky; husky; en_US; 386113915\)$/)
})

test('authorization header dibangun dan di-parse', () => {
  const client = new Client()
  client.authorizationData = { ds_user_id: '123', sessionid: '123%3Aabc' }
  const header = client.authorization
  assert.ok(header.startsWith('Bearer IGT:2:'))
  assert.deepEqual(client.parseAuthorization(header), client.authorizationData)
  assert.equal(client.userId, 123)
})

test('extractMediaV1 memilih resolusi terbesar', () => {
  const media = extractMediaV1({
    pk: 1,
    id: '1_2',
    media_type: 1,
    user: { pk: 2, username: 'u' },
    caption: { text: 'hi' },
    image_versions2: {
      candidates: [
        { url: 'small', width: 10, height: 10 },
        { url: 'big', width: 100, height: 100 }
      ]
    }
  })
  assert.equal(media.thumbnail_url, 'big')
  assert.equal(media.caption_text, 'hi')
  assert.equal(media.pk, '1')
})

test('password encrypt menghasilkan payload yang bisa didekripsi', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = publicKey.export({ type: 'spki', format: 'pem' })
  const client = new Client()
  client.passwordPublicKeys = async () => [42, Buffer.from(pem).toString('base64')]
  const encrypted = await client.passwordEncrypt('rahasia123')
  const [, version, timestamp, payload] = encrypted.split(':')
  assert.equal(version, '4')
  const raw = Buffer.from(payload, 'base64')
  assert.equal(raw[0], 1)
  assert.equal(raw[1], 42)
  const iv = raw.subarray(2, 14)
  const size = raw.readUInt16LE(14)
  const rsa = raw.subarray(16, 16 + size)
  const tag = raw.subarray(16 + size, 32 + size)
  const body = raw.subarray(32 + size)
  const sessionKey = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, rsa)
  const decipher = createDecipheriv('aes-256-gcm', sessionKey, iv)
  decipher.setAAD(Buffer.from(timestamp))
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  assert.equal(plain, 'rahasia123')
})

const withServer = async (handler, run) => {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(server.address().port)
  } finally {
    server.close()
  }
}

test('privateRequest: POST bertanda tangan, header, cookie, dan error mapping', async () => {
  const seen = []
  await withServer(
    (req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        seen.push({ url: req.url, method: req.method, headers: req.headers, body })
        if (req.url.includes('login_required')) {
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ message: 'login_required', status: 'fail' }))
          return
        }
        if (req.url.includes('missing')) {
          res.writeHead(404)
          res.end('nope')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['csrftoken=abc; Path=/', 'ds_user_id=77; Path=/'] })
        res.end(JSON.stringify({ status: 'ok', echoed: true }))
      })
    },
    async (port) => {
      const client = new Client({ requestTimeout: 0 })
      const origin = `http://127.0.0.1:${port}`
      const realRequest = client.private.request.bind(client.private)
      client.private.request = (method, url, opts) =>
        realRequest(method, url.replace('https://i.instagram.com', origin), opts)

      const ok = await client.privateRequest('accounts/test/', { a: 1 }, { login: true })
      assert.equal(ok.status, 'ok')
      assert.equal(seen[0].method, 'POST')
      assert.equal(seen[0].url, '/api/v1/accounts/test/')
      assert.equal(seen[0].body, `signed_body=SIGNATURE.${encodeURIComponent('{"a":1}')}`)
      assert.equal(seen[0].headers['user-agent'], client.userAgent)
      assert.equal(seen[0].headers['x-ig-app-id'], '567067343352427')
      assert.equal(client.token, 'abc')
      assert.equal(client.userId, 77)

      await client.privateRequest('feed/get/', null, { params: { a: true, b: null, c: 'x y' } })
      assert.equal(seen[1].method, 'GET')
      assert.equal(seen[1].url, '/api/v1/feed/get/?a=True&c=x+y')
      assert.match(seen[1].headers.cookie, /ds_user_id=77/)

      await assert.rejects(client.privateRequest('login_required/'), LoginRequired)
      await assert.rejects(client.privateRequest('missing/'), ClientNotFoundError)
    }
  )
})

test('userFollowersV1 mengikuti cursor dan membuang duplikat', async () => {
  let calls = 0
  await withServer(
    (req, res) => {
      calls += 1
      const page = calls === 1
        ? { users: [{ pk: 1, username: 'a' }, { pk: 2, username: 'b' }], next_max_id: 'c1', status: 'ok' }
        : { users: [{ pk: 2, username: 'b' }, { pk: 3, username: 'c' }], status: 'ok' }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(page))
    },
    async (port) => {
      const client = new Client({ requestTimeout: 0 })
      const realRequest = client.private.request.bind(client.private)
      client.private.request = (method, url, opts) =>
        realRequest(method, url.replace('https://i.instagram.com', `http://127.0.0.1:${port}`), opts)
      const users = await client.userFollowersV1('9')
      assert.deepEqual(users.map((u) => u.pk), ['1', '2', '3'])
    }
  )
})
