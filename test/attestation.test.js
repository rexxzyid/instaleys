import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPublicKey, verify } from 'node:crypto'
import { CaptchaChallengeRequired, Client } from '../src/index.js'

const withServer = async (handler, run) => {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(server.address().port)
  } finally {
    server.close()
  }
}

const loggedInClient = (port) => {
  const client = new Client({ requestTimeout: 0 })
  client.authorizationData = { ds_user_id: '123', sessionid: '123%3Aabcdefghijklmnopqrstuvwxyz0123456789' }
  client.uuid = 'uuid-1'
  client.phoneId = 'phone-1'
  client.logger = { ...client.logger, error: () => {} }
  const origin = `http://127.0.0.1:${port}`
  const realRequest = client.private.request.bind(client.private)
  client.private.request = (method, url, opts) => realRequest(method, url.replace(/^https:\/\/[^/]+/, origin), opts)
  return client
}

const recordingServer = (seen, respond) => (req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    seen.push({ url: new URL(req.url, 'http://localhost'), method: req.method, body, headers: req.headers })
    const [status, payload] = respond(seen.length)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(payload)
  })
}

const json = (data, status = 200) => () => [status, JSON.stringify(data)]
const formBody = (body) => Object.fromEntries(new URLSearchParams(body))
const fromB64u = (value) => JSON.parse(Buffer.from(value, 'base64url').toString())

const verifySignature = (client, message, signatureB64u) =>
  verify(
    'sha256',
    Buffer.from(message),
    { key: createPublicKey(client.usdidPrivateKey), dsaEncoding: 'der' },
    Buffer.from(signatureB64u, 'base64url')
  )

test('captchaResolve tanpa handler melempar CaptchaChallengeRequired', async () => {
  const client = new Client({ requestTimeout: 0 })
  await assert.rejects(client.captchaResolve({ site_key: 'k' }), (error) => {
    assert.ok(error instanceof CaptchaChallengeRequired)
    assert.match(error.message, /No captcha handler/)
    assert.deepEqual(error.challenge_details, { site_key: 'k' })
    return true
  })
})

test('captchaResolve meneruskan empat kunci detail dan mengembalikan token', async () => {
  const client = new Client({ requestTimeout: 0 })
  let received = null
  client.setCaptchaHandler(async (details) => {
    received = details
    return 'token-1'
  })
  assert.equal(await client.captchaResolve({ site_key: 'k', extra: 1 }), 'token-1')
  assert.deepEqual(received, { site_key: 'k', page_url: null, challenge_type: null, raw_challenge_json: null })
})

test('captchaResolve membungkus token kosong dan exception handler', async () => {
  const client = new Client({ requestTimeout: 0 })
  client.setCaptchaHandler(() => '')
  await assert.rejects(client.captchaResolve(), /did not return a valid token string/)
  client.setCaptchaHandler(() => {
    throw new Error('boom')
  })
  await assert.rejects(client.captchaResolve(), (error) => {
    assert.ok(error instanceof CaptchaChallengeRequired)
    assert.match(error.message, /unexpected exception: boom/)
    return true
  })
  const own = new CaptchaChallengeRequired('own')
  client.setCaptchaHandler(() => {
    throw own
  })
  await assert.rejects(client.captchaResolve(), (error) => error === own)
  client.setCaptchaHandler(null)
  await assert.rejects(client.captchaResolve(), /No captcha handler/)
})

test('usdidGenerate membuat kunci P-256 dan tersimpan di settings', () => {
  const client = new Client({ requestTimeout: 0 })
  assert.deepEqual(client.getUsdidSettings(), {})
  assert.equal(client.getSettings().usdid, undefined)
  const usdid = client.usdidGenerate()
  assert.match(usdid, /^[0-9a-f-]{36}$/)
  assert.equal(client.usdidGenerate(), usdid)
  assert.notEqual(client.usdidGenerate(true), usdid)
  assert.equal(Buffer.from(client.usdidKid, 'base64url').length, 32)
  assert.equal(createPublicKey(client.usdidPrivateKey).asymmetricKeyDetails.namedCurve, 'prime256v1')
  const saved = client.getSettings().usdid
  assert.deepEqual(saved, {
    usdid: client.usdid,
    kid: client.usdidKid,
    private_key: client.usdidPrivateKey,
    registered: false
  })
  const restored = new Client({ requestTimeout: 0 })
  restored.setSettings(client.getSettings())
  assert.deepEqual(restored.getUsdidSettings(), saved)
})

test('setUsdidSettings mereset nonce dan setUuids menghapus usdid bila phone_id berubah', () => {
  const client = new Client({ requestTimeout: 0 })
  client.usdidGenerate()
  client.attestationChallengeNonce = 'n'
  assert.equal(client.setUsdidSettings(client.getUsdidSettings()), true)
  assert.equal(client.attestationChallengeNonce, '')
  client.setUuids({ phone_id: client.phoneId })
  assert.notEqual(client.usdidPrivateKey, '')
  client.setUuids({ phone_id: 'phone-baru' })
  assert.equal(client.usdidPrivateKey, '')
  assert.equal(client.setUsdidSettings(null), false)
})

test('usdidHeader tiga bagian, ditandatangani, dan di-cache', () => {
  const client = new Client({ requestTimeout: 0 })
  client.usdidGenerate()
  const header = client.usdidHeader()
  const [usdid, expiresAt, signature] = header.split('.')
  assert.equal(usdid, client.usdid)
  assert.ok(Math.abs(Number(expiresAt) - (Math.floor(Date.now() / 1000) + 3600)) <= 2)
  assert.equal(verifySignature(client, `${usdid}.${expiresAt}`, signature), true)
  assert.equal(client.usdidHeader(), header)
  assert.equal(client.baseHeaders['X-Meta-Usdid'], header)
  client.usdidHeaderExpiresAt = Math.floor(Date.now() / 1000) + 100
  assert.notEqual(client.usdidHeader(), header)
})

test('baseHeaders tidak memuat X-Meta-Usdid tanpa kunci', () => {
  const client = new Client({ requestTimeout: 0 })
  assert.equal('X-Meta-Usdid' in client.baseHeaders, false)
})

test('usdidRegistrationToken membentuk JWS ES256 yang valid', () => {
  const client = new Client({ requestTimeout: 0 })
  client.usdidGenerate()
  const token = fromB64u(client.usdidRegistrationToken())
  const payload = fromB64u(token.payload)
  const protectedHeader = fromB64u(token.signatures[0].protected)
  assert.deepEqual(Object.keys(payload), ['sub', 'iat', 'aud', 'exp', 'pub', 'alg'])
  assert.equal(payload.sub, client.usdid)
  assert.equal(payload.aud, '567067343352427')
  assert.equal(payload.exp - payload.iat, 3600)
  assert.equal(payload.alg, 'ES256')
  assert.deepEqual(Buffer.from(payload.pub, 'base64'), client.usdidPublicKeyDer)
  assert.deepEqual(protectedHeader, { typ: 'JWT', alg: 'ES256', kid: client.usdidKid, aid: '567067343352427', ver: '1' })
  const signedPart = `${token.signatures[0].protected}.${token.payload}`
  assert.equal(verifySignature(client, signedPart, token.signatures[0].signature), true)
})

test('usdidRegister mengirim IGUSDIDRegistrationMutation dan membaca success', async () => {
  const seen = []
  const responses = [
    json({ data: { xdt_usdid_registration: { success: true } } }),
    json({ data: { other: { success: true } } })
  ]
  await withServer(recordingServer(seen, (n) => responses[n - 1]()), async (port) => {
    const client = loggedInClient(port)
    assert.equal(await client.usdidRegister(), true)
    assert.equal(client.usdidRegistered, true)
    assert.notEqual(client.usdidPrivateKey, '')
    const body = formBody(seen[0].body)
    assert.equal(seen[0].url.pathname, '/graphql_www')
    assert.equal(body.fb_api_req_friendly_name, 'IGUSDIDRegistrationMutation')
    assert.equal(body.client_doc_id, '124930351917786857261002920888')
    const variables = JSON.parse(body.variables)
    assert.equal(variables.input.fdid.sensitive_string_value, 'phone-1')
    assert.equal(typeof variables.input.usdid_token.sensitive_string_value, 'string')
    assert.equal(seen[0].headers['x-root-field-name'], 'usdid_registration')
    assert.equal(seen[0].headers['x-graphql-client-library'], 'pando')
    assert.equal(seen[0].headers['x-meta-usdid'].split('.')[0], client.usdid)
    assert.equal(await client.usdidRegister(), false)
  })
})

test('attestationCreateAndroidKeystore menyimpan nonce dan attestationParams membentuk JSON', async () => {
  const seen = []
  await withServer(recordingServer(seen, json({ status: 'ok', challenge_nonce: 'c-1', key_nonce: 'k-1' })), async (port) => {
    const client = loggedInClient(port)
    assert.equal(client.attestationParams(), '')
    await client.attestationCreateAndroidKeystore()
    assert.equal(seen[0].method, 'POST')
    assert.equal(seen[0].url.pathname, '/api/v1/attestation/create_android_keystore/')
    assert.deepEqual(formBody(seen[0].body), { app_scoped_device_id: 'uuid-1', key_hash: '' })
    assert.equal(seen[0].headers['x-fb-friendly-name'], 'IgApi: attestation/create_android_keystore/')
    assert.equal(client.attestationChallengeNonce, 'c-1')
    assert.equal(client.attestationKeyNonce, 'k-1')
    assert.equal(
      client.attestationParams(),
      '{"attestation":[{"version":2,"type":"keystore","errors":[-1013],"challenge_nonce":"c-1","signed_nonce":"","key_hash":""}]}'
    )
    assert.equal(JSON.parse(client.attestationParams('x')).attestation[0].challenge_nonce, 'x')
  })
})
