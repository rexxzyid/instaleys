import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  ChallengeError,
  ChallengeRequired,
  ChallengeSelfieCaptcha,
  ChallengeUnknownStep,
  Client,
  LegacyForceSetNewPasswordForm,
  RecaptchaChallengeForm,
  SelectContactPointRecoveryForm,
  SubmitPhoneNumberForm
} from '../src/index.js'
import { HttpSession } from '../src/http.js'
import { extractMessages, normalizeChallengeApiPath } from '../src/mixins/challenge.js'

const withServer = async (handler, run) => {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(server.address().port)
  } finally {
    server.close()
  }
}

const redirectSession = (session, origin) => {
  const realRequest = session.request.bind(session)
  session.request = (method, url, opts) => realRequest(method, url.replace(/^https:\/\/[^/]+/, origin), opts)
  return session
}

const challengeClient = (port, opts = {}) => {
  const client = new Client({ requestTimeout: 0, ...opts })
  client.authorizationData = { ds_user_id: '123', sessionid: '123%3Aabcdefghijklmnopqrstuvwxyz0123456789' }
  client.uuid = 'uuid-1'
  client.androidDeviceId = 'android-1'
  client.username = 'me'
  client.challengeWaitSeconds = 0
  client.logger = { ...client.logger, warn: () => {}, error: () => {} }
  const origin = `http://127.0.0.1:${port}`
  redirectSession(client.private, origin)
  client.challengeHttpSession = () => redirectSession(new HttpSession(), origin)
  return client
}

const recordingServer = (seen, respond) => (req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    seen.push({ url: new URL(req.url, 'http://localhost'), method: req.method, body, headers: req.headers })
    const [status, payload, headers = {}] = respond(seen.length, seen.at(-1))
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(payload)
  })
}

const reply = (data, status = 200, headers = {}) => [status, JSON.stringify(data), headers]
const formBody = (body) => Object.fromEntries(new URLSearchParams(body))
const signedBody = (body) => JSON.parse(decodeURIComponent(body.replace('signed_body=SIGNATURE.', '')))
const challengePayload = (apiPath, extra = {}) => ({
  message: 'challenge_required',
  challenge: { api_path: apiPath, ...extra },
  status: 'fail'
})

test('normalizeChallengeApiPath dan extractMessages mengikuti Python', () => {
  assert.equal(normalizeChallengeApiPath('/api/v1/challenge/1/a/'), '/challenge/1/a/')
  assert.equal(normalizeChallengeApiPath('/api/challenge/1/a/'), '/challenge/1/a/')
  assert.equal(normalizeChallengeApiPath('/challenge/1/a/'), '/challenge/1/a/')
  assert.deepEqual(
    extractMessages({ extraData: { content: [{ title: 'Judul' }, { text: 'Teks.' }, { title: null, text: 'x' }, {}] } }),
    ['Judul.', 'Teks.']
  )
})

test('handleChallengeResult memetakan challengeType ke exception', () => {
  const client = new Client({ requestTimeout: 0 })
  assert.throws(
    () => client.handleChallengeResult({ challenge: { challengeType: 'SelectContactPointRecoveryForm', errors: ['e1'], extraData: { content: [{ title: 'T' }] } } }),
    (error) => error instanceof SelectContactPointRecoveryForm && error.message === 'T. e1' && error.challenge.errors[0] === 'e1'
  )
  assert.throws(() => client.handleChallengeResult({ challengeType: 'RecaptchaChallengeForm', errors: ['a', 'b'] }), (error) => error instanceof RecaptchaChallengeForm && error.message === 'a. b')
  const form = { challengeType: 'VerifySMSCodeForm' }
  assert.equal(client.handleChallengeResult({ challenge: form }), form)
  assert.throws(() => client.handleChallengeResult({ challengeType: 'SubmitPhoneNumberForm', fields: {} }), SubmitPhoneNumberForm)
  assert.throws(() => client.handleChallengeResult({ challengeType: 'Other', errors: ['x'] }), /Unsupported challenge type: Other\. x \(Please manual login\)/)
  assert.throws(() => client.handleChallengeResult({ challenge: 'bad' }), /Malformed nested challenge/)
  assert.throws(() => client.handleChallengeResult({ type: 'CHALLENGE_REDIRECTION' }), (error) => error.name === 'ChallengeRedirection')
  assert.deepEqual(client.handleChallengeResult({ status: 'ok' }), { status: 'ok' })
})

test('resolveChallenge menolak auth_platform dan native_flow tanpa request', async () => {
  const client = new Client({ requestTimeout: 0 })
  await assert.rejects(client.resolveChallenge(challengePayload('/api/v1/auth_platform/x/')), (error) => error instanceof ChallengeRequired && /auth platform/.test(error.message))
  await assert.rejects(
    client.resolveChallenge(challengePayload('/challenge/1/n/', { native_flow: true })),
    (error) => error instanceof ChallengeRequired && /native challenge flow/.test(error.message) && error.raw_message === 'challenge_required'
  )
  await assert.rejects(client.resolveChallenge({ message: 'challenge_required' }), ChallengeRequired)
})

test('resolveChallenge GET challenge dengan challenge_context legacy lalu delta_login_review memilih choice 0', async () => {
  const seen = []
  const responses = [reply({ step_name: 'delta_login_review', status: 'ok' }), reply({ status: 'ok' })]
  await withServer(recordingServer(seen, (n) => responses[n - 1]), async (port) => {
    const client = challengeClient(port)
    assert.equal(await client.resolveChallenge(challengePayload('/api/v1/challenge/42/NONCE/')), true)
    assert.equal(seen[0].method, 'GET')
    assert.equal(seen[0].url.pathname, '/api/v1/challenge/42/NONCE/')
    assert.deepEqual(Object.fromEntries(seen[0].url.searchParams), {
      guid: 'uuid-1',
      device_id: 'android-1',
      challenge_context: '{"step_name": "", "nonce_code": "NONCE", "user_id": 42, "is_stateless": false}'
    })
    assert.equal(seen[1].method, 'POST')
    assert.equal(seen[1].url.pathname, '/api/challenge/42/NONCE/')
    assert.deepEqual(signedBody(seen[1].body), { choice: '0' })
  })
})

test('resolveChallenge memakai challenge_context dari payload', async () => {
  const seen = []
  await withServer(recordingServer(seen, () => reply({ step_name: '', action: 'close', status: 'ok' })), async (port) => {
    const client = challengeClient(port)
    assert.equal(await client.resolveChallenge(challengePayload('/challenge/1/a/', { challenge_context: 'ctx' })), true)
    assert.equal(seen[0].url.searchParams.get('challenge_context'), 'ctx')
    assert.equal(seen.length, 1)
  })
})

test('select_verify_method memilih email lalu mengirim security_code dari handler', async () => {
  const seen = []
  const handlerCalls = []
  const responses = [
    reply({ step_name: 'select_verify_method', step_data: { email: 'x@y', phone_number: '+1' }, status: 'ok' }),
    reply({ status: 'ok' }),
    reply({ action: 'close', status: 'ok' })
  ]
  await withServer(recordingServer(seen, (n) => responses[n - 1]), async (port) => {
    const client = challengeClient(port, {
      challengeCodeHandler: async (username, choice) => {
        handlerCalls.push([username, choice])
        return '123456'
      }
    })
    assert.equal(await client.resolveChallenge(challengePayload('/challenge/1/a/')), true)
    assert.deepEqual(handlerCalls, [['me', 1]])
    assert.deepEqual(signedBody(seen[1].body), { choice: '1' })
    assert.deepEqual(signedBody(seen[2].body), { security_code: '123456' })
    assert.equal(seen[2].url.pathname, '/api/v1/challenge/1/a/')
  })
})

test('verify_phone tanpa kode melempar ChallengeRequired tanpa message asli', async () => {
  const seen = []
  await withServer(recordingServer(seen, () => reply({ step_name: 'verify_phone', status: 'ok', message: 'm' })), async (port) => {
    const client = challengeClient(port, { challengeCodeHandler: async () => '' })
    await assert.rejects(client.resolveChallenge(challengePayload('/challenge/1/a/')), (error) => {
      assert.ok(error instanceof ChallengeRequired)
      assert.match(error.message, /Challenge code required/)
      assert.equal(error.step_name, 'verify_phone')
      return true
    })
  })
})

test('add_birthday mengirim tanggal acak dalam rentang Python', async () => {
  const seen = []
  const responses = [reply({ step_name: 'add_birthday', status: 'ok' }), reply({ status: 'ok' })]
  await withServer(recordingServer(seen, (n) => responses[n - 1]), async (port) => {
    const client = challengeClient(port)
    await client.resolveChallenge(challengePayload('/challenge/1/a/'))
    const body = signedBody(seen[1].body)
    assert.ok(Number(body.birthday_year) >= 1970 && Number(body.birthday_year) <= 2004)
    assert.ok(Number(body.birthday_month) >= 1 && Number(body.birthday_month) <= 12)
    assert.ok(Number(body.birthday_day) >= 1 && Number(body.birthday_day) <= 28)
  })
})

test('submit_phone memakai phoneNumber dan menolak bila step tidak maju', async () => {
  const seen = []
  const responses = [
    reply({ step_name: 'submit_phone', status: 'ok' }),
    reply({ step_name: 'submit_phone', status: 'ok' })
  ]
  await withServer(recordingServer(seen, (n) => responses[n - 1]), async (port) => {
    const client = challengeClient(port, { phoneNumber: '+62811' })
    await assert.rejects(client.resolveChallenge(challengePayload('/challenge/1/a/')), /did not advance/)
    assert.deepEqual(signedBody(seen[1].body), { phone_number: '+62811' })
  })
  const client = new Client({ requestTimeout: 0 })
  client.lastJson = { step_name: 'submit_phone' }
  await assert.rejects(client.challengeResolveSimple('/challenge/1/a/'), /Phone number required/)
})

test('step manual dan tidak dikenal melempar exception yang sesuai', async () => {
  const client = new Client({ requestTimeout: 0 })
  client.lastJson = { step_name: 'ufac_www_bloks' }
  await assert.rejects(client.challengeResolveSimple('/c/'), /UFAC web bloks/)
  client.lastJson = { step_name: 'selfie_captcha' }
  await assert.rejects(client.challengeResolveSimple('/c/'), ChallengeSelfieCaptcha)
  client.lastJson = { step_name: 'aneh' }
  await assert.rejects(client.challengeResolveSimple('/c/'), ChallengeUnknownStep)
  client.lastJson = { step_name: '', status: 'ok' }
  await assert.rejects(client.challengeResolveSimple('/c/'), Error)
})

test('select_contact_point_recovery mengirim pilihan, kode, lalu choice 0 pada review', async () => {
  const seen = []
  const responses = [
    reply({ step_name: 'select_contact_point_recovery', step_data: { phone_number: '+1' }, status: 'ok' }),
    reply({ status: 'ok' }),
    reply({ step_name: 'review_contact_point_change', status: 'ok' }),
    reply({ status: 'ok' })
  ]
  await withServer(recordingServer(seen, (n) => responses[n - 1]), async (port) => {
    const client = challengeClient(port, { challengeCodeHandler: async () => '999999' })
    assert.equal(await client.resolveChallenge(challengePayload('/challenge/1/a/')), true)
    assert.deepEqual(signedBody(seen[1].body), { choice: '0' })
    assert.deepEqual(signedBody(seen[2].body), { security_code: '999999' })
    assert.deepEqual(signedBody(seen[3].body), { choice: 0 })
  })
})

test('bloks redirect memanggil take_challenge dengan choice 0', async () => {
  const seen = []
  const responses = [
    reply({ bloks_action: 'com.bloks.www.ig.challenge.redirect.async', challenge_context: 'ctx', status: 'ok' }),
    reply({ status: 'ok', action: 'close' })
  ]
  await withServer(recordingServer(seen, (n) => responses[n - 1]), async (port) => {
    const client = challengeClient(port)
    assert.equal(await client.resolveChallenge(challengePayload('/challenge/1/a/')), true)
    assert.equal(seen[1].url.pathname, '/api/v1/bloks/apps/com.instagram.challenge.navigation.take_challenge/')
    const body = formBody(seen[1].body)
    assert.equal(body._uuid, 'uuid-1')
    assert.equal(body.has_follow_up_screens, '0')
    assert.equal(body.challenge_context, 'ctx')
    assert.equal(body.choice, '0')
    assert.equal(body.bloks_versioning_id, client.bloksVersioningId)
    assert.deepEqual(JSON.parse(body.bk_client_context), { bloks_version: client.bloksVersioningId, styles_id: 'instagram' })
  })
})

test('challengeBloksRedirectDismiss menolak tanpa konteks dan melempar bila masih redirect', async () => {
  const client = new Client({ requestTimeout: 0 })
  await assert.rejects(client.challengeBloksRedirectDismiss(), /No pending Bloks redirect/)
  const seen = []
  const responses = [reply({ status: 'ok', bloks_action: 'com.bloks.www.ig.challenge.redirect.async' }), reply({ status: 'ok', type: 'CHALLENGE_REDIRECTION' })]
  await withServer(recordingServer(seen, (n) => responses[n - 1]), async (port) => {
    const live = challengeClient(port)
    live.lastJson = { bloks_action: 'com.bloks.www.ig.challenge.redirect.async', challenge_context: 'ctx' }
    await assert.rejects(live.challengeBloksRedirectDismiss(), /Bloks redirect checkpoint/)
    live.lastJson = { bloks_action: 'com.bloks.www.ig.challenge.redirect.async', challenge_context: 'ctx' }
    assert.equal(await live.challengeBloksRedirectDismiss(), true)
    assert.equal('choice' in formBody(seen[0].body), false)
  })
})

test('change_password memakai changePasswordHandler dan bloksChangePassword', async () => {
  const client = new Client({ requestTimeout: 0, changePasswordHandler: async () => 'Baru123!' })
  client.challengeWaitSeconds = 0
  client.logger = { ...client.logger, info: () => {} }
  const calls = []
  client.passwordEncrypt = async (password) => `#PWD_INSTAGRAM:4:0:${password}`
  client.bloksChallengeTakeChallenge = async (opts) => {
    calls.push(opts)
    return { status: 'ok' }
  }
  client.lastJson = { step_name: 'change_password', challenge_context: 'ctx' }
  assert.equal(await client.challengeResolveSimple('/c/'), true)
  assert.deepEqual(calls[0], {
    challengeContext: 'ctx',
    extraData: { enc_new_password1: '#PWD_INSTAGRAM:4:0:Baru123!', enc_new_password2: '#PWD_INSTAGRAM:4:0:Baru123!' }
  })
  client.lastJson = { step_name: 'change_password' }
  await assert.rejects(client.challengeResolveSimple('/c/'), /did not return a challenge context/)
})

test('contact form web: pilih email, kirim kode, review data, lalu approve', async () => {
  const seen = []
  const responses = [
    reply({ message: 'challenge_required', status: 'fail' }, 400),
    [200, '<html></html>', { 'set-cookie': 'csrftoken=csrf-web; Path=/' }],
    reply({ challengeType: 'VerifyEmailCodeForm' }),
    reply({ challenge: { challengeType: 'ReviewContactPointChangeForm', extraData: { content: [{ labeled_list_entries: [{ list_item_text: 'me' }, { list_item_text: '+62 811-22' }] }] }, navigation: { forward: '/challenge/next/' } } }),
    reply({ type: 'CHALLENGE_REDIRECTION', status: 'ok' })
  ]
  await withServer(recordingServer(seen, (n) => responses[n - 1]), async (port) => {
    const client = challengeClient(port, { challengeCodeHandler: async () => '111222', phoneNumber: '+6281122' })
    client.private.cookies.set('mid', 'mid-1')
    client.private.cookies.set('csrftoken', 'csrf-1')
    client.private.cookies.set('sessionid', 'secret')
    assert.equal(await client.resolveChallenge(challengePayload('/challenge/1/a/')), true)
    assert.equal(seen[1].method, 'GET')
    assert.equal(seen[1].url.pathname, '/challenge/1/a/')
    assert.match(seen[1].headers.cookie, /mid=mid-1/)
    assert.doesNotMatch(seen[1].headers.cookie, /sessionid/)
    assert.equal(seen[1].headers['x-requested-with'], 'com.instagram.android')
    assert.deepEqual(formBody(seen[2].body), { choice: '1' })
    assert.equal(seen[2].headers['x-csrftoken'], 'csrf-web')
    assert.equal(seen[2].headers['x-requested-with'], 'XMLHttpRequest')
    assert.match(seen[2].headers['x-instagram-ajax'], /^[0-9a-f]{12}$/)
    assert.deepEqual(formBody(seen[3].body), { security_code: '111222' })
    assert.equal(seen[4].url.pathname, '/challenge/next/')
    const final = formBody(seen[4].body)
    assert.equal(final.choice, '0')
    assert.match(final.enc_new_password1, /^#PWD_INSTAGRAM_BROWSER:0:\d+:$/)
    assert.equal(final.new_password1, '')
  })
})

test('contact form web: SelectContactPointRecoveryForm beralih ke SMS lalu gagal bila tetap', async () => {
  const seen = []
  const select = reply({ challenge: { challengeType: 'SelectContactPointRecoveryForm', errors: ['no'] } })
  const responses = [reply({ message: 'challenge_required', status: 'fail' }, 400), [200, ''], select, select]
  await withServer(recordingServer(seen, (n) => responses[n - 1]), async (port) => {
    const client = challengeClient(port)
    await assert.rejects(client.resolveChallenge(challengePayload('/challenge/1/a/')), SelectContactPointRecoveryForm)
    assert.deepEqual(formBody(seen[2].body), { choice: '1' })
    assert.deepEqual(formBody(seen[3].body), { choice: '0' })
  })
})

test('contact form web: LegacyForceSetNewPasswordForm dan data akun tidak cocok', async () => {
  const run = async (codeResult, opts, expected) => {
    const seen = []
    const responses = [
      reply({ message: 'challenge_required', status: 'fail' }, 400),
      [200, ''],
      reply({ challengeType: 'VerifySMSCodeForm' }),
      reply(codeResult)
    ]
    await withServer(recordingServer(seen, (n) => responses[n - 1]), async (port) => {
      const client = challengeClient(port, { challengeCodeHandler: async () => '1', ...opts })
      await assert.rejects(client.resolveChallenge(challengePayload('/challenge/1/a/')), expected)
    })
  }
  await run({ challengeType: 'LegacyForceSetNewPasswordForm', extraData: { content: [{ title: 'Ganti' }] } }, {}, (error) => error instanceof LegacyForceSetNewPasswordForm && /change password! Ganti\./.test(error.message))
  await run({ challengeType: 'ReviewContactPointChangeForm', extraData: { content: [{ labeled_list_entries: [{ list_item_text: 'me' }] }] }, navigation: { forward: '/f/' } }, { email: 'a@b' }, (error) => error instanceof ChallengeError && /Data invalid: "a@b"/.test(error.message))
})

test('privateRequest memanggil resolver bawaan saat ChallengeRequired lalu mengulang request', async () => {
  const seen = []
  const responses = [
    reply(challengePayload('/challenge/1/a/'), 400),
    reply({ step_name: '', action: 'close', status: 'ok' }),
    reply({ status: 'ok', value: 1 })
  ]
  await withServer(recordingServer(seen, (n) => responses[n - 1]), async (port) => {
    const client = challengeClient(port)
    const result = await client.privateRequest('feed/timeline/')
    assert.equal(result.value, 1)
    assert.deepEqual(seen.map((request) => request.url.pathname), ['/api/v1/feed/timeline/', '/api/v1/challenge/1/a/', '/api/v1/feed/timeline/'])
  })
})

test('withChallengeFlow false melempar ChallengeRequired langsung', async () => {
  const seen = []
  await withServer(recordingServer(seen, () => reply(challengePayload('/challenge/1/a/'), 400)), async (port) => {
    const client = challengeClient(port, { withChallengeFlow: false })
    await assert.rejects(client.privateRequest('feed/timeline/'), ChallengeRequired)
    assert.equal(seen.length, 1)
  })
})
