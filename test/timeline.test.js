import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Client } from '../src/index.js'
import { dumps, generateSignature } from '../src/utils.js'

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

const jsonServer = (seen, bodies) => (req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    seen.push({ url: new URL(req.url, 'http://localhost'), method: req.method, headers: req.headers, body })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(bodies.shift()))
  })
}

const media = (pk) => ({ pk, id: `${pk}_9`, user: { pk: '9', username: 'u' } })

test('reels memakai endpoint clips/connected dan body signed string', async () => {
  const seen = []
  const bodies = [{ items: [{ media: media('1') }], paging_info: { more_available: false } }]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const items = await client.reels(10)
    assert.deepEqual(items.map((item) => item.pk), ['1'])
    assert.equal(seen[0].method, 'POST')
    assert.equal(seen[0].url.pathname, '/api/v1/clips/connected/')
    assert.equal(seen[0].url.searchParams.get('max_id'), '')
    assert.equal(seen[0].body, generateSignature(dumps(' ')))
  })
})

test('exploreReels dan friendsReels memakai endpoint masing-masing', async () => {
  const seen = []
  const bodies = [
    { items: [], paging_info: { more_available: false } },
    { items: [], paging_info: { more_available: false } }
  ]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    await client.exploreReels()
    await client.friendsReels()
    assert.equal(seen[0].url.pathname, '/api/v1/clips/discover/')
    assert.equal(seen[1].url.pathname, '/api/v1/clips/discover/social/')
  })
})

test('reelsTimelineMedia memaginasi, melewati item tanpa media, dan berhenti di amount', async () => {
  const seen = []
  const bodies = [
    {
      items: [{ media: media('1') }, { media: null }, { media: media('2') }],
      paging_info: { more_available: true, max_id: 'next' }
    },
    {
      items_with_ads: [{ media: media('3') }, { media: media('4') }],
      paging_info: { more_available: true, max_id: 'next-2' }
    }
  ]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const items = await client.reelsTimelineMedia('reels', 3)
    assert.deepEqual(items.map((item) => item.pk), ['1', '2', '3'])
    assert.equal(seen[1].url.searchParams.get('max_id'), 'next')
  })
})

test('reelsTimelineMedia berhenti di lastMediaPk dan pada cursor yang berulang', async () => {
  const seen = []
  const bodies = [{ items: [{ media: media('1') }, { media: media('2') }], paging_info: { more_available: true } }]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const items = await client.reelsTimelineMedia('reels', 10, '2')
    assert.deepEqual(items.map((item) => item.pk), ['1'])
  })

  const seenLoop = []
  const loopBodies = [
    { items: [{ media: media('1') }], paging_info: { more_available: true, max_id: 'same' } },
    { items: [{ media: media('2') }], paging_info: { more_available: true, max_id: 'same' } }
  ]
  await withServer(jsonServer(seenLoop, loopBodies), async (port) => {
    const client = loggedInClient(port)
    const items = await client.reelsTimelineMedia('reels', 10)
    assert.deepEqual(items.map((item) => item.pk), ['1', '2'])
    assert.equal(seenLoop.length, 2)
  })
})

test('reelsTimelineMedia menolak collection tidak dikenal dan mengembalikan hasil sebagian saat error', async () => {
  const client = new Client({ requestTimeout: 0 })
  const warnings = []
  client.logger = { ...client.logger, warn: (message) => warnings.push(message) }
  assert.deepEqual(await client.reelsTimelineMedia('unknown'), [])
  assert.equal(warnings.length, 1)

  let calls = 0
  await withServer(
    (req, res) => {
      calls += 1
      if (calls === 1) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ items: [{ media: media('1') }], paging_info: { more_available: true, max_id: 'n' } }))
        return
      }
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{}')
    },
    async (port) => {
      const partial = loggedInClient(port)
      partial.logger = { ...partial.logger, error: () => {} }
      const items = await partial.reels(10)
      assert.deepEqual(items.map((item) => item.pk), ['1'])
    }
  )
})
