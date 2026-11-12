import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Client } from '../src/index.js'
import { TOTP } from '../src/mixins/totp.js'

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

const withServer = async (handler, run) => {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(server.address().port)
  } finally {
    server.close()
  }
}

test('TOTP generateOtp sesuai vektor RFC 6238 SHA-1', () => {
  const totp = new TOTP(RFC_SECRET, { digits: 8 })
  const vectors = [
    [1, '94287082'],
    [37037036, '07081804'],
    [37037037, '14050471'],
    [41152263, '89005924'],
    [66666666, '69279037'],
    [666666666, '65353130']
  ]
  for (const [counter, expected] of vectors) {
    assert.equal(totp.generateOtp(counter), expected)
  }
})

test('TOTP default enam digit dan vektor RFC 4226', () => {
  const totp = new TOTP(RFC_SECRET)
  assert.equal(totp.digits, 6)
  assert.equal(totp.generateOtp(0), '755224')
  assert.equal(totp.generateOtp(1), '287082')
  assert.equal(totp.generateOtp(2), '359152')
})

test('TOTP byteSecret menerima base32 huruf kecil dan tanpa padding', () => {
  const totp = new TOTP('gezdgnbvgy3tqojqgezdgnbvgy3tqojq')
  assert.deepEqual(totp.byteSecret(), Buffer.from('12345678901234567890'))
  assert.deepEqual(new TOTP('GEZDGNBVGY3TQOJQ').byteSecret(), Buffer.from('1234567890'))
  assert.throws(() => new TOTP('GEZDGNBVGY3TQOJ!').byteSecret(), /Invalid base32 character/)
})

test('TOTP intToBytestring mengikuti OATH big-endian dengan padding', () => {
  assert.deepEqual(TOTP.intToBytestring(1), Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]))
  assert.deepEqual(TOTP.intToBytestring(0), Buffer.alloc(8))
  assert.deepEqual(TOTP.intToBytestring(0x0102, 4), Buffer.from([0, 0, 1, 2]))
  assert.deepEqual(TOTP.intToBytestring(0x0102030405n, 4), Buffer.from([1, 2, 3, 4, 5]))
})

test('TOTP generateOtp menolak input negatif dan code memakai interval 30 detik', () => {
  const totp = new TOTP(RFC_SECRET)
  assert.throws(() => totp.generateOtp(-1), RangeError)
  assert.equal(totp.interval, 30)
  const originalNow = Date.now
  Date.now = () => 59000
  try {
    assert.equal(totp.code(), '287082')
  } finally {
    Date.now = originalNow
  }
})

test('TOTP nama dan issuer mengikuti default Python', () => {
  const totp = new TOTP(RFC_SECRET)
  assert.equal(totp.name, 'Secret')
  assert.equal(totp.issuer, null)
  assert.equal(new TOTP(RFC_SECRET, { name: 'Akun', issuer: 'Instagram' }).name, 'Akun')
})

test('totpGenerateSeed, totpEnable, dan totpDisable memanggil endpoint yang benar', async () => {
  const seen = []
  await withServer(
    (req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        seen.push({ url: req.url, method: req.method, body })
        res.writeHead(200, { 'content-type': 'application/json' })
        if (req.url.includes('generate_two_factor_totp_key')) {
          res.end(JSON.stringify({ status: 'ok', totp_seed: 'GEZDGNBVGY3TQOJQ' }))
          return
        }
        if (req.url.includes('enable_totp_two_factor')) {
          res.end(JSON.stringify({ status: 'ok', backup_codes: ['11111111', '22222222'] }))
          return
        }
        res.end(JSON.stringify({ status: 'ok' }))
      })
    },
    async (port) => {
      const client = new Client({ requestTimeout: 0 })
      const origin = `http://127.0.0.1:${port}`
      const realRequest = client.private.request.bind(client.private)
      client.private.request = (method, url, opts) =>
        realRequest(method, url.replace('https://i.instagram.com', origin), opts)

      const seed = await client.totpGenerateSeed()
      assert.equal(seed, 'GEZDGNBVGY3TQOJQ')
      assert.equal(seen[0].method, 'POST')
      assert.equal(seen[0].url, '/api/v1/accounts/generate_two_factor_totp_key/')

      const codes = await client.totpEnable('123456')
      assert.deepEqual(codes, ['11111111', '22222222'])
      assert.equal(seen[1].method, 'POST')
      assert.equal(seen[1].url, '/api/v1/accounts/enable_totp_two_factor/')

      assert.equal(await client.totpDisable(), true)
      assert.equal(seen[2].method, 'POST')
      assert.equal(seen[2].url, '/api/v1/accounts/disable_totp_two_factor/')

      const decode = (body) => JSON.parse(decodeURIComponent(body.replace('signed_body=SIGNATURE.', '')))
      const seedPayload = decode(seen[0].body)
      assert.equal(seedPayload._uuid, client.uuid)
      assert.equal(seedPayload.device_id, client.androidDeviceId)
      const enablePayload = decode(seen[1].body)
      assert.equal(enablePayload.verification_code, '123456')
      const disablePayload = decode(seen[2].body)
      assert.equal(disablePayload._uuid, client.uuid)
    }
  )
})

test('totpGenerateCode memakai seed yang diberikan', () => {
  const client = new Client()
  const originalNow = Date.now
  Date.now = () => 59000
  try {
    assert.equal(client.totpGenerateCode(RFC_SECRET), '287082')
  } finally {
    Date.now = originalNow
  }
})
