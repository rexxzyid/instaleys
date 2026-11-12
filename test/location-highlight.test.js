import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Client, HighlightNotFound, LocationNotFound, WrongCursorError } from '../src/index.js'

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
    seen.push({ url: new URL(req.url, 'http://localhost'), method: req.method, body })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(bodies.shift()))
  })
}

const media = (pk) => ({ pk, id: `${pk}_9`, user: { pk: '9', username: 'u' } })

test('locationSearch menambahkan lat/lng yang hilang pada venue', async () => {
  const seen = []
  const bodies = [
    {
      venues: [
        { id: 111, name: 'A', external_id: 222, external_source: 'facebook_places' },
        { id: 333, name: 'B', lat: -6.1, lng: 106.8, external_id: 444 }
      ]
    }
  ]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const locations = await client.locationSearch(-6.2, 106.8)
    assert.equal(locations.length, 2)
    assert.equal(locations[0].lat, -6.2)
    assert.equal(locations[0].lng, 106.8)
    assert.equal(locations[1].lat, -6.1)
    assert.equal(seen[0].url.pathname, '/api/v1/location_search/')
    assert.equal(seen[0].url.searchParams.get('latitude'), '-6.2')
    assert.equal(seen[0].url.searchParams.get('longitude'), '106.8')
  })
})

test('locationInfoV1 menyimpulkan external_id_source dari facebook_places_id', async () => {
  const seen = []
  const bodies = [{ name: 'Place', id: 555, facebook_places_id: 999 }]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const location = await client.locationInfoV1(555)
    assert.equal(location.pk, 555)
    assert.equal(location.external_id, 999)
    assert.equal(location.external_id_source, 'facebook_places')
    assert.equal(seen[0].url.pathname, '/api/v1/locations/555/location_info/')
  })
})

test('locationInfoV1 melempar LocationNotFound bila nama tidak ada', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: 'Sorry, this page isn\'t available.' }))
    },
    async (port) => {
      const client = loggedInClient(port)
      await assert.rejects(client.locationInfoV1(1), LocationNotFound)
    }
  )
})

test('locationMediasV1Chunk memakai sections, cursor, dan tab yang benar', async () => {
  const seen = []
  const bodies = [
    {
      sections: [
        { layout_content: { medias: [{ media: media('1') }, { media: media('2') }] } },
        { layout_content: {} }
      ],
      next_page: 2,
      next_max_id: 'cursor-max',
      next_media_ids: ['a', 'b']
    },
    { sections: [{ layout_content: { medias: [{ media: media('3') }] } }] }
  ]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const [items, next] = await client.locationMediasV1Chunk(555, 10, 'recent')
    assert.deepEqual(items.map((item) => item.pk), ['1', '2'])
    assert.equal(seen[0].url.pathname, '/api/v1/locations/555/sections/')
    const body = JSON.parse(decodeURIComponent(seen[0].body.replace('signed_body=SIGNATURE.', '')))
    assert.equal(body.tab, 'recent')
    assert.equal(body.session_id, client.clientSessionId)
    assert.equal(body._uuid, client.uuid)
    assert.equal(body.max_id, undefined)
    const decoded = JSON.parse(Buffer.from(next, 'base64').toString('utf8'))
    assert.deepEqual(decoded, ['cursor-max', 2, ['a', 'b']])

    const [more] = await client.locationMediasV1Chunk(555, 10, 'ranked', next)
    assert.deepEqual(more.map((item) => item.pk), ['3'])
    const second = JSON.parse(decodeURIComponent(seen[1].body.replace('signed_body=SIGNATURE.', '')))
    assert.equal(second.max_id, 'cursor-max')
    assert.equal(second.page, 2)
    assert.deepEqual(second.next_media_ids, ['a', 'b'])
  })
})

test('locationMediasV1Chunk melempar WrongCursorError untuk cursor rusak', async () => {
  const client = new Client({ requestTimeout: 0 })
  await assert.rejects(client.locationMediasV1Chunk(1, 10, 'ranked', 'not-a-cursor'), WrongCursorError)
  await assert.rejects(client.locationMediasV1Chunk(1, 10, 'bogus'), /tab_key/)
})

test('locationMediasV1 memangkas hasil ke amount', async () => {
  const seen = []
  const bodies = [
    {
      sections: [{ layout_content: { medias: [{ media: media('1') }, { media: media('2') }] } }],
      next_page: 1,
      next_max_id: 'm',
      next_media_ids: []
    }
  ]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const items = await client.locationMediasV1(1, 1)
    assert.deepEqual(items.map((item) => item.pk), ['1'])
    assert.equal(seen.length, 1)
  })
})

test('locationGuidesV1 mengekstrak summary dan cover media', async () => {
  const seen = []
  const bodies = [
    {
      guides: [
        {
          summary: { id: 'g1', title: 'Guide', description: 'd', cover_media: { pk: '9', user: { pk: '9', username: 'u' } } }
        }
      ]
    }
  ]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const guides = await client.locationGuidesV1(555)
    assert.equal(guides.length, 1)
    assert.equal(guides[0].title, 'Guide')
    assert.equal(guides[0].cover_media.pk, '9')
    assert.equal(seen[0].url.pathname, '/api/v1/guides/location/555/')
  })
})

test('userHighlightsV1 memakai highlights_tray dan memotong jumlah', async () => {
  const seen = []
  const bodies = [
    {
      tray: [
        { id: 'highlight:1', title: 'A', items: [] },
        { id: 'highlight:2', title: 'B', items: [] }
      ]
    }
  ]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const highlights = await client.userHighlightsV1(777, 1)
    assert.equal(highlights.length, 1)
    assert.equal(highlights[0].pk, '1')
    assert.equal(seen[0].url.pathname, '/api/v1/highlights/777/highlights_tray/')
    const params = seen[0].url.searchParams
    assert.ok(params.get('supported_capabilities_new').includes('SUPPORTED_SDK_VERSIONS'))
    assert.ok(params.has('battery_level'))
  })
})

test('highlightInfoV1 memanggil feed/reels_media dan melempar HighlightNotFound', async () => {
  const seen = []
  const bodies = [{ reels: { 'highlight:9': { id: 'highlight:9', title: 'H', items: [] } } }]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const highlight = await client.highlightInfoV1(9)
    assert.equal(highlight.pk, '9')
    assert.equal(seen[0].url.pathname, '/api/v1/feed/reels_media/')
    const body = JSON.parse(decodeURIComponent(seen[0].body.replace('signed_body=SIGNATURE.', '')))
    assert.deepEqual(body.user_ids, ['highlight:9'])
    assert.equal(body.source, 'profile')
  })

  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ reels: {} }))
    },
    async (port) => {
      const client = loggedInClient(port)
      await assert.rejects(client.highlightInfoV1(9), HighlightNotFound)
    }
  )
})

test('highlightEdit, highlightCreate, dan highlightDelete memakai body yang benar', async () => {
  const seen = []
  const bodies = [
    { reel: { id: 'highlight:1', items: [] } },
    { reel: { id: 'highlight:1', items: [] } },
    { reel: { id: 'highlight:2', items: [] } },
    { status: 'ok' }
  ]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    await client.highlightChangeTitle(1, 'New')
    const edit = JSON.parse(decodeURIComponent(seen[0].body.replace('signed_body=SIGNATURE.', '')))
    assert.equal(edit.title, 'New')
    assert.deepEqual(JSON.parse(edit.added_media_ids), [])
    assert.equal(seen[0].url.pathname, '/api/v1/highlights/highlight:1/edit_reel/')

    await client.highlightAddStories(1, ['111_9'])
    const add = JSON.parse(decodeURIComponent(seen[1].body.replace('signed_body=SIGNATURE.', '')))
    assert.deepEqual(JSON.parse(add.added_media_ids), ['111_9'])
    assert.equal(add.title, undefined)

    await client.highlightCreate('T', ['111_9', '222_9'])
    const create = JSON.parse(decodeURIComponent(seen[2].body.replace('signed_body=SIGNATURE.', '')))
    assert.equal(create.title, 'T')
    assert.deepEqual(JSON.parse(create.media_ids), ['111_9', '222_9'])
    assert.deepEqual(JSON.parse(create.cover).media_id, '111_9')
    assert.equal(seen[2].url.pathname, '/api/v1/highlights/create_reel/')

    assert.equal(await client.highlightDelete(2), true)
    assert.equal(seen[3].url.pathname, '/api/v1/highlights/highlight:2/delete_reel/')
  })
})