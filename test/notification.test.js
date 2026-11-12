import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Client, ValidationError } from '../src/index.js'

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
  const origin = `http://127.0.0.1:${port}`
  const realRequest = client.private.request.bind(client.private)
  client.private.request = (method, url, opts) =>
    realRequest(method, url.replace('https://i.instagram.com', origin), opts)
  return client
}

const recordingServer = (seen, respond) => (req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    seen.push({ url: new URL(req.url, 'http://localhost'), method: req.method, body })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(respond(seen.length)))
  })
}

const signedBody = (body) => JSON.parse(decodeURIComponent(body.replace('signed_body=SIGNATURE.', '')))

test('notificationSettings mengirim content_type, setting_value, _uid, dan _uuid', async () => {
  const seen = []
  await withServer(recordingServer(seen, () => ({ status: 'ok' })), async (port) => {
    const client = loggedInClient(port)
    assert.equal(await client.notificationConnection('everyone'), true)
    assert.equal(seen[0].method, 'POST')
    assert.equal(seen[0].url.pathname, '/api/v1/notifications/change_notification_settings/')
    assert.deepEqual(signedBody(seen[0].body), {
      content_type: 'connection_notification',
      setting_value: 'everyone',
      _uid: '123',
      _uuid: 'uuid-1'
    })
    await client.notificationReminders()
    assert.equal(signedBody(seen[1].body).content_type, 'notification_reminders')
    assert.equal(signedBody(seen[1].body).setting_value, 'off')
    await client.notificationLogin()
    assert.equal(signedBody(seen[2].body).content_type, 'login_notification')
  })
})

test('notificationMuteAll memvalidasi nilai dan default 8_hour', async () => {
  const seen = []
  await withServer(recordingServer(seen, () => ({ status: 'ok' })), async (port) => {
    const client = loggedInClient(port)
    await client.notificationMuteAll()
    assert.deepEqual(signedBody(seen[0].body).content_type, 'mute_all')
    assert.deepEqual(signedBody(seen[0].body).setting_value, '8_hour')
    await assert.rejects(client.notificationMuteAll('off'), ValidationError)
    await assert.rejects(client.notificationLikes('8_hour'), ValidationError)
    assert.equal(seen.length, 1)
  })
})

test('notificationDisable mematikan 24 jenis dan berhenti saat ada yang gagal', async () => {
  const seen = []
  await withServer(recordingServer(seen, () => ({ status: 'ok' })), async (port) => {
    const client = loggedInClient(port)
    assert.equal(await client.notificationDisable(), true)
    assert.equal(seen.length, 24)
    assert.ok(seen.every((entry) => signedBody(entry.body).setting_value === 'off'))
    assert.equal(signedBody(seen[0].body).content_type, 'likes')
    assert.equal(signedBody(seen[23].body).content_type, 'login_notification')
  })

  const failing = []
  await withServer(recordingServer(failing, (count) => ({ status: count === 3 ? 'nok' : 'ok' })), async (port) => {
    const client = loggedInClient(port)
    assert.equal(await client.notificationDisable(), false)
    assert.equal(failing.length, 3)
  })
})

test('featuredAccountsV1 dan getAccountFamilyV1 memakai GET ke endpoint multiple_accounts', async () => {
  const seen = []
  await withServer(recordingServer(seen, () => ({ status: 'ok', accounts: [] })), async (port) => {
    const client = loggedInClient(port)
    await client.featuredAccountsV1(777)
    assert.equal(seen[0].method, 'GET')
    assert.equal(seen[0].url.pathname, '/api/v1/multiple_accounts/get_featured_accounts/')
    assert.equal(seen[0].url.searchParams.get('target_user_id'), '777')
    await client.getAccountFamilyV1()
    assert.equal(seen[1].method, 'GET')
    assert.equal(seen[1].url.pathname, '/api/v1/multiple_accounts/get_account_family/')
  })
})
