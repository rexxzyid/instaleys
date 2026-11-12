import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Client, CollectionNotFound } from '../src/index.js'

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

const collectionItem = (id, name) => ({
  collection_id: id,
  collection_name: name,
  collection_type: 'MEDIA',
  collection_media_count: 1,
  cover_media: { pk: 'cover' }
})

const mediaItem = (pk) => ({ media: { pk, id: `${pk}_9`, user: { pk: '9', username: 'u' } } })

test('collections memaginasi dan memetakan collection_* ke model Collection', async () => {
  const seen = []
  const bodies = [
    { items: [collectionItem('1', 'Repost')], more_available: true, next_max_id: 'next-1' },
    { items: [collectionItem('2', 'Saved')], more_available: false }
  ]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const collections = await client.collections()
    assert.deepEqual(collections, [
      { id: '1', name: 'Repost', type: 'MEDIA', media_count: 1 },
      { id: '2', name: 'Saved', type: 'MEDIA', media_count: 1 }
    ])
    assert.equal(seen[0].url.pathname, '/api/v1/collections/list/')
    assert.equal(
      seen[0].url.searchParams.get('collection_types'),
      '["ALL_MEDIA_AUTO_COLLECTION","PRODUCT_AUTO_COLLECTION","MEDIA"]'
    )
    assert.equal(seen[0].url.searchParams.get('max_id'), '')
    assert.equal(seen[1].url.searchParams.get('max_id'), 'next-1')
  })
})

test('collections mengembalikan hasil sebagian bila satu halaman gagal', async () => {
  let calls = 0
  await withServer(
    (req, res) => {
      calls += 1
      if (calls === 1) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ items: [collectionItem('1', 'Repost')], more_available: true, next_max_id: 'n' }))
        return
      }
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{}')
    },
    async (port) => {
      const client = loggedInClient(port)
      client.logger = { ...client.logger, error: () => {} }
      const collections = await client.collections()
      assert.deepEqual(collections, [{ id: '1', name: 'Repost', type: 'MEDIA', media_count: 1 }])
    }
  )
})

test('collectionPkByName melempar CollectionNotFound bila tidak ada', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ items: [], more_available: false }))
    },
    async (port) => {
      const client = loggedInClient(port)
      await assert.rejects(client.collectionPkByName('missing'), CollectionNotFound)
    }
  )
})

test('collectionMediasV1Chunk memilih endpoint sesuai collection_pk', async () => {
  const seen = []
  const bodies = [
    { items: [mediaItem('11')], next_max_id: 'n1' },
    { items: [mediaItem('12')], max_id: 'n2' },
    { items: [mediaItem('13')] }
  ]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const [numeric, next] = await client.collectionMediasV1Chunk('555', '')
    assert.equal(numeric[0].pk, '11')
    assert.equal(next, 'n1')
    assert.equal(seen[0].url.pathname, '/api/v1/feed/collection/555/')
    assert.equal(seen[0].url.searchParams.get('include_igtv_preview'), 'false')

    await client.collectionMediasV1Chunk('liked', 'abc')
    assert.equal(seen[1].url.pathname, '/api/v1/feed/liked/')
    assert.equal(seen[1].url.searchParams.get('max_id'), 'abc')

    await client.collectionMediasV1Chunk('saved')
    assert.equal(seen[2].url.pathname, '/api/v1/feed/saved/posts/')
    assert.equal(seen[2].url.searchParams.get('max_id'), null)
  })
})

test('collectionMediasV1 berhenti di amount dan lastMediaPk', async () => {
  const seen = []
  const bodies = [
    { items: [mediaItem('1'), mediaItem('2')], next_max_id: 'n1' },
    { items: [mediaItem('3')], next_max_id: 'n2' }
  ]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const items = await client.collectionMediasV1('555', 3)
    assert.deepEqual(items.map((item) => item.pk), ['1', '2', '3'])
    assert.equal(seen[0].url.searchParams.get('include_igtv_preview'), 'false')
  })

  const seenLast = []
  await withServer(
    jsonServer(seenLast, [{ items: [mediaItem('1'), mediaItem('2')], next_max_id: 'n' }]),
    async (port) => {
      const client = loggedInClient(port)
      const limited = await client.collectionMediasV1('555', 10, '2')
      assert.deepEqual(limited.map((item) => item.pk), ['1'])
    }
  )
})

test('mediaSave dan mediaUnsave memakai endpoint, body, dan collection id yang benar', async () => {
  const seen = []
  const bodies = [{ status: 'ok' }, { status: 'ok' }, { status: 'nok' }]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    assert.equal(await client.mediaSave('111_222', 333), true)
    assert.equal(seen[0].url.pathname, '/api/v1/media/111/save/')
    assert.equal(seen[0].method, 'POST')
    const body = JSON.parse(decodeURIComponent(seen[0].body.replace('signed_body=SIGNATURE.', '')))
    assert.equal(body.module_name, 'feed_timeline')
    assert.equal(body.radio_type, 'wifi-none')
    assert.equal(body.added_collection_ids, '[333]')
    assert.equal(body._uuid, client.uuid)
    assert.equal(body.device_id, client.androidDeviceId)

    assert.equal(await client.mediaUnsave('111_222'), true)
    assert.equal(seen[1].url.pathname, '/api/v1/media/111/unsave/')
    const unsaveBody = JSON.parse(decodeURIComponent(seen[1].body.replace('signed_body=SIGNATURE.', '')))
    assert.equal(unsaveBody.added_collection_ids, undefined)

    assert.equal(await client.mediaSave('111_222'), false)
  })
})
