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
  const origin = `http://127.0.0.1:${port}`
  const realRequest = client.private.request.bind(client.private)
  client.private.request = (method, url, opts) =>
    realRequest(method, url.replace('https://i.instagram.com', origin), opts)
  return client
}

const withRequestCapture = async (run) => {
  const seen = []
  await withServer(
    (req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        seen.push({ url: req.url, method: req.method, headers: req.headers, body })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            status: 'ok',
            payload: { item_id: 'item-1', user_id: 123, timestamp: 1700000000000000, client_context: 'ctx' }
          })
        )
      })
    },
    (port) => run(port, seen)
  )
}

test('directSendCutoutSticker mengirim generic_share ke user', async () => {
  await withRequestCapture(async (port, seen) => {
    const client = loggedInClient(port)
    const sent = await client.directSendCutoutSticker('987654', { userIds: [456] })
    assert.equal(sent.id, 'item-1')
    assert.equal(seen[0].method, 'POST')
    assert.equal(seen[0].url, '/api/v1/direct_v2/threads/broadcast/generic_share/')
    assert.match(seen[0].headers['content-type'], /application\/x-www-form-urlencoded/)
    const body = new URLSearchParams(seen[0].body)
    assert.equal(body.get('action'), 'send_item')
    assert.equal(body.get('embedded_ent_type'), '101')
    assert.equal(body.get('json_params'), '{"sticker_id":"cutout_photo_987654","embedded_ent_type":101}')
    assert.equal(body.get('recipient_users'), '[[456]]')
    assert.equal(body.get('thread_ids'), null)
    assert.equal(body.get('client_context'), body.get('mutation_token'))
    assert.equal(body.get('offline_threading_id'), body.get('mutation_token'))
    assert.equal(body.get('device_id'), client.androidDeviceId)
    assert.equal(body.get('_uuid'), client.uuid)
  })
})

test('directSendCutoutSticker mengirim ke thread id besar tanpa kehilangan presisi', async () => {
  await withRequestCapture(async (port, seen) => {
    const client = loggedInClient(port)
    await client.directSendCutoutSticker('111', { threadIds: ['9876543210987654321'] })
    const body = new URLSearchParams(seen[0].body)
    assert.equal(body.get('thread_ids'), '[9876543210987654321]')
    assert.equal(body.get('recipient_users'), null)
  })
})

test('directSendCutoutSticker memvalidasi login dan target', async () => {
  const anonymous = new Client({ requestTimeout: 0 })
  await assert.rejects(anonymous.directSendCutoutSticker('1', { userIds: [2] }), /Login required/)

  const client = new Client({ requestTimeout: 0 })
  client.authorizationData = { ds_user_id: '123' }
  await assert.rejects(client.directSendCutoutSticker('1'), ValidationError)
  await assert.rejects(client.directSendCutoutSticker('1', { userIds: [2], threadIds: [3] }), ValidationError)
})
