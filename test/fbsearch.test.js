import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Client, ClientError } from '../src/index.js'
import { extractTrack } from '../src/extractors.js'

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
  client.timezoneOffset = 25200
  const origin = `http://127.0.0.1:${port}`
  const realRequest = client.private.request.bind(client.private)
  client.private.request = (method, url, opts) =>
    realRequest(method, url.replace('https://i.instagram.com', origin), opts)
  return client
}

const jsonServer = (seen, bodies) => (req, res) => {
  seen.push({ url: new URL(req.url, 'http://localhost'), method: req.method })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(bodies.shift()))
}

const paramsOf = (entry) => Object.fromEntries(entry.url.searchParams)

const media = (pk) => ({ pk, id: `${pk}_9`, user: { pk: '9', username: 'u' } })

test('extractTrack mengambil uri dari dash_manifest dan unescape HTML', () => {
  const track = extractTrack({
    id: '1',
    dash_manifest: '<MPD><BaseURL>https://cdn.example/a.mp4?x=1&amp;y=2</BaseURL></MPD>',
    cover_artwork_uri: ''
  })
  assert.equal(track.uri, 'https://cdn.example/a.mp4?x=1&y=2')
  assert.equal(track.cover_artwork_uri, null)
  assert.equal(track.cover_artwork_thumbnail_uri, null)
  assert.deepEqual(track.territory_validity_periods, {})
  assert.equal(extractTrack({ dash_manifest: '' }).uri, null)
})

test('fbsearchPlaces, searchHashtags, dan searchMusic memakai params dari sumber', async () => {
  const seen = []
  const bodies = [
    { items: [{ location: { pk: 1, name: 'A', lat: 1, lng: 2 } }] },
    { results: [{ id: '5', name: 'travel', allow_following: 1, profile_pic_url: '' }] },
    { items: [{ track: { id: 't1', dash_manifest: '<BaseURL>u</BaseURL>' } }, { other: 1 }] }
  ]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const places = await client.fbsearchPlaces('kopi')
    assert.equal(places[0].name, 'A')
    assert.equal(seen[0].method, 'GET')
    assert.equal(seen[0].url.pathname, '/api/v1/fbsearch/places/')
    assert.deepEqual(paramsOf(seen[0]), {
      search_surface: 'places_search_page',
      timezone_offset: '25200',
      lat: '40.74',
      lng: '-73.94',
      count: '30',
      query: 'kopi'
    })

    const tags = await client.searchHashtags('travel')
    assert.equal(tags[0].allow_following, true)
    assert.equal(tags[0].profile_pic_url, null)
    assert.equal(seen[1].url.pathname, '/api/v1/tags/search/')
    assert.deepEqual(paramsOf(seen[1]), {
      search_surface: 'hashtag_search_page',
      timezone_offset: '25200',
      count: '30',
      q: 'travel'
    })

    const tracks = await client.searchMusic('lagu')
    assert.equal(tracks.length, 1)
    assert.equal(tracks[0].uri, 'u')
    assert.equal(seen[2].url.pathname, '/api/v1/music/audio_global_search/')
    assert.equal(seen[2].url.searchParams.get('query'), 'lagu')
    assert.ok(seen[2].url.searchParams.get('browse_session_id'))
  })
})

test('fbsearchTopsearchFlat, suggested profiles, dan web topsearch hashtags', async () => {
  const seen = []
  const bodies = [
    { list: [{ position: 0 }] },
    { users: [{ pk: 7, username: 'x' }] },
    { hashtags: [{ hashtag: { id: '1', name: 'a' } }] }
  ]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    assert.deepEqual(await client.fbsearchTopsearchFlat('q'), [{ position: 0 }])
    assert.deepEqual(paramsOf(seen[0]), {
      search_surface: 'top_search_page',
      context: 'blended',
      timezone_offset: '25200',
      count: '30',
      query: 'q'
    })
    const users = await client.fbsearchSuggestedProfiles('7')
    assert.equal(users[0].pk, '7')
    assert.deepEqual(paramsOf(seen[1]), { target_user_id: '7', include_friendship_status: 'true' })
    const tags = await client.webSearchTopsearchHashtags('a')
    assert.equal(tags[0].name, 'a')
    assert.equal(seen[2].url.pathname, '/api/v1/web/search/topsearch/')
    assert.deepEqual(paramsOf(seen[2]), {
      search_surface: 'web_top_search',
      context: 'blended',
      include_reel: 'true',
      query: 'a'
    })
  })
})

test('fbsearchItem hanya mengirim param opsional yang terisi', async () => {
  const seen = []
  await withServer(jsonServer(seen, [{ ok: 1 }, { ok: 2 }]), async (port) => {
    const client = loggedInClient(port)
    await client.fbsearchItem('reels_serp', 'clips_search_page', 'q')
    assert.equal(seen[0].url.pathname, '/api/v1/fbsearch/reels_serp/')
    assert.deepEqual(paramsOf(seen[0]), { search_surface: 'clips_search_page', query: 'q', count: '30' })
    await client.fbsearchItem('x', 's', 'q', { timezoneOffset: 7, count: 0, reelsPageIndex: 0, pageIndex: 0, pageToken: 'p' })
    assert.deepEqual(paramsOf(seen[1]), {
      search_surface: 's',
      query: 'q',
      timezone_offset: '7',
      reels_page_index: '0',
      page_index: '0',
      page_token: 'p'
    })
  })
})

test('typeahead dan typehead memakai typeahead_search_page', async () => {
  const seen = []
  const bodies = [{ a: 1 }, { b: 1 }, { stream_rows: [{ users: [{ pk: 1 }] }, { users: [{ pk: 2 }] }, {}] }]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    await client.fbsearchKeywordTypeahead('q')
    assert.equal(seen[0].url.pathname, '/api/v1/fbsearch/keyword_typeahead/')
    assert.deepEqual(paramsOf(seen[0]), {
      search_surface: 'typeahead_search_page',
      query: 'q',
      context: 'blended',
      count: '30'
    })
    await client.fbsearchTypeaheadStream('q', { timezoneOffset: 3 })
    assert.equal(seen[1].url.pathname, '/api/v1/fbsearch/typeahead_stream/')
    assert.equal(seen[1].url.searchParams.get('timezone_offset'), '3')
    const users = await client.fbsearchTypehead('q')
    assert.deepEqual(users, [{ pk: 1 }, { pk: 2 }])
    assert.deepEqual(paramsOf(seen[2]), {
      search_surface: 'typeahead_search_page',
      timezone_offset: '25200',
      query: 'q',
      context: 'blended'
    })
  })
})

test('fbsearchRecent memetakan user, hashtag, dan keyword', async () => {
  const seen = []
  const bodies = [
    {
      status: 'ok',
      recent: [
        { client_time: 1, user: { pk: 5, username: 'u' } },
        { client_time: 2, hashtag: { id: '9', name: 'h', formatted_media_count: '1K' } },
        { client_time: 3, keyword: { name: 'k' } }
      ]
    },
    { status: 'nok' }
  ]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const recent = await client.fbsearchRecent()
    assert.equal(recent.length, 3)
    assert.equal(recent[0][0], 1)
    assert.equal(recent[0][1].pk, '5')
    assert.deepEqual(recent[1], [2, { id: '9', name: 'h', media_count: '1K' }])
    assert.deepEqual(recent[2], [3, { name: 'k' }])
    assert.equal(seen[0].url.pathname, '/api/v1/fbsearch/recent_searches/')
    await assert.rejects(client.fbsearchRecent(), ClientError)
  })
})

test('serp v2 mengirim cursor dan rank_token', async () => {
  const seen = []
  await withServer(jsonServer(seen, [{}, {}, {}]), async (port) => {
    const client = loggedInClient(port)
    await client.fbsearchAccountsV2('q', 'tok')
    assert.equal(seen[0].url.pathname, '/api/v1/fbsearch/account_serp/')
    assert.deepEqual(paramsOf(seen[0]), {
      search_surface: 'account_serp',
      timezone_offset: '25200',
      query: 'q',
      page_token: 'tok'
    })
    await client.fbsearchReelsV2('q', { reelsMaxId: 'r' })
    assert.deepEqual(paramsOf(seen[1]), {
      search_surface: 'clips_search_page',
      timezone_offset: '25200',
      query: 'q',
      reels_max_id: 'r'
    })
    await client.fbsearchTopsearchV2('q')
    assert.equal(seen[2].url.pathname, '/api/v1/fbsearch/top_serp/')
    assert.equal(seen[2].url.searchParams.get('rank_token'), client.rankToken)
    assert.equal(seen[2].url.searchParams.get('search_surface'), 'top_serp')
  })
})

test('mediaSearch mengumpulkan node grid dan mengikuti paging', async () => {
  const seen = []
  const bodies = [
    {
      media_grid: {
        sections: [
          {
            layout_content: {
              one_by_two_item: { media: media('1'), clips: { items: [{ media: media('2') }, { nope: 1 }] } },
              fill_items: [{ media: media('3') }]
            }
          }
        ],
        has_more: true,
        next_max_id: 'n1',
        rank_token: 'rk'
      }
    },
    { media_grid: { sections: [{ layout_content: { medias: [{ media: media('4') }, { media: media('5') }] } }] } }
  ]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const medias = await client.mediaSearch('q', 4)
    assert.deepEqual(medias.map((item) => item.pk), ['1', '2', '3', '4'])
    assert.equal(seen.length, 2)
    assert.equal(seen[1].url.searchParams.get('next_max_id'), 'n1')
    assert.equal(seen[1].url.searchParams.get('rank_token'), 'rk')
  })
})
