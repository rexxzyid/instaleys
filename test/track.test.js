import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Client, TrackNotFound } from '../src/index.js'

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
  client.logger = { ...client.logger, error: () => {} }
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
    const [status, payload] = respond(seen.length)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(payload)
  })
}

const ok = (data) => () => [200, JSON.stringify({ status: 'ok', ...data })]
const formBody = (body) => Object.fromEntries(new URLSearchParams(body))
const signedBody = (body) => JSON.parse(decodeURIComponent(body.replace('signed_body=SIGNATURE.', '')))

test('musicInFeedAudioBrowser, musicTrending, musicTopTrends, dan musicClipsAudioBrowser mengirim form tanpa signature', async () => {
  const seen = []
  await withServer(recordingServer(seen, ok()), async (port) => {
    const client = loggedInClient(port)
    await client.musicInFeedAudioBrowser('browse-1')
    await client.musicTrending()
    await client.musicTopTrends()
    await client.musicClipsAudioBrowser(undefined, 'browse-2')
    assert.equal(seen[0].url.pathname, '/api/v1/music/music_in_feed_audio_browser/')
    assert.deepEqual(formBody(seen[0].body), {
      product: 'music_in_feed',
      _uuid: 'uuid-1',
      browse_session_id: 'browse-1'
    })
    assert.equal(seen[1].url.pathname, '/api/v1/music/trending/')
    assert.deepEqual(formBody(seen[1].body), { product: 'feed_post', _uuid: 'uuid-1' })
    assert.equal(seen[2].url.pathname, '/api/v1/music/top_trends/')
    assert.deepEqual(formBody(seen[2].body), { product: 'music_in_feed', _uuid: 'uuid-1', page_size: '15' })
    assert.equal(seen[3].url.pathname, '/api/v1/music/clips_audio_browser/')
    assert.deepEqual(formBody(seen[3].body), {
      product: 'story_camera_clips_v2',
      _uuid: 'uuid-1',
      browse_session_id: 'browse-2'
    })
  })
})

test('musicInFeedAudioBrowser membuat browse_session_id bila tidak diberikan', async () => {
  const seen = []
  await withServer(recordingServer(seen, ok()), async (port) => {
    const client = loggedInClient(port)
    await client.musicInFeedAudioBrowser()
    assert.match(formBody(seen[0].body).browse_session_id, /^[0-9a-f-]{36}$/)
  })
})

test('musicSearchV2 mengirim from_typeahead string dan q', async () => {
  const seen = []
  await withServer(recordingServer(seen, ok()), async (port) => {
    const client = loggedInClient(port)
    await client.musicSearchV2('lagu', { fromTypeahead: true, searchSessionId: 's-1', browseSessionId: 'b-1' })
    assert.equal(seen[0].method, 'POST')
    assert.equal(seen[0].url.pathname, '/api/v1/music/search_v2/')
    assert.deepEqual(formBody(seen[0].body), {
      from_typeahead: 'true',
      search_session_id: 's-1',
      product: 'music_in_feed',
      q: 'lagu',
      _uuid: 'uuid-1',
      browse_session_id: 'b-1'
    })
  })
})

test('musicKeywordSearch memakai GET dengan query params', async () => {
  const seen = []
  await withServer(recordingServer(seen, ok()), async (port) => {
    const client = loggedInClient(port)
    await client.musicKeywordSearch('abc', { browseSessionId: 'b-1' })
    assert.equal(seen[0].method, 'GET')
    assert.equal(seen[0].url.pathname, '/api/v1/music/keyword_search/')
    assert.deepEqual(Object.fromEntries(seen[0].url.searchParams), {
      num_keywords: '3',
      search_session_id: '',
      product: 'music_in_feed',
      q: 'abc',
      browse_session_id: 'b-1'
    })
  })
})

test('musicBookmark, musicBookmarked, dan musicVerifyOriginalAudioTitle', async () => {
  const seen = []
  const responses = [
    [200, JSON.stringify({ status: 'nok' })],
    [200, JSON.stringify({ status: 'nok', success: true })],
    [200, JSON.stringify({ status: 'ok', items: [] })],
    [200, JSON.stringify({ status: 'ok' })],
    [200, JSON.stringify({ status: 'ok', is_valid: true })],
    [200, JSON.stringify({ status: 'ok', is_valid: false })]
  ]
  await withServer(recordingServer(seen, (n) => responses[n - 1]), async (port) => {
    const client = loggedInClient(port)
    assert.equal(await client.musicBookmark(42), false)
    assert.equal(await client.musicBookmark('43', 'feed'), true)
    assert.deepEqual(formBody(seen[0].body), {
      original_audio_id: '42',
      _uuid: 'uuid-1',
      surface_requested_from: 'audio_aggregation_page'
    })
    assert.equal(formBody(seen[1].body).surface_requested_from, 'feed')
    await client.musicBookmarked()
    await client.musicBookmarked('cursor-1')
    assert.equal(seen[2].url.pathname, '/api/v1/music/playlist/bookmarked/')
    assert.deepEqual(formBody(seen[2].body), { _uuid: 'uuid-1' })
    assert.deepEqual(formBody(seen[3].body), { _uuid: 'uuid-1', max_id: 'cursor-1' })
    assert.equal(await client.musicVerifyOriginalAudioTitle('Judul'), true)
    assert.equal(await client.musicVerifyOriginalAudioTitle('Judul'), false)
    assert.equal(seen[4].url.pathname, '/api/v1/music/verify_original_audio_title/')
    assert.deepEqual(formBody(seen[4].body), { original_audio_name: 'Judul', _uuid: 'uuid-1' })
  })
})

test('trackInfoByCanonicalId mengekstrak track dan melempar TrackNotFound bila kosong', async () => {
  const seen = []
  const responses = [
    [200, JSON.stringify({
      status: 'ok',
      metadata: { music_info: { music_asset_info: { id: '1', title: 'T', display_artist: 'A', highlight_start_times_in_ms: [] } } }
    })],
    [200, JSON.stringify({ status: 'ok', metadata: {} })]
  ]
  await withServer(recordingServer(seen, (n) => responses[n - 1]), async (port) => {
    const client = loggedInClient(port)
    const track = await client.trackInfoByCanonicalId(777)
    assert.equal(track.title, 'T')
    assert.equal(seen[0].url.pathname, '/api/v1/clips/music/')
    assert.deepEqual(signedBody(seen[0].body), {
      tab_type: 'clips',
      referrer_media_id: '',
      _uuid: 'uuid-1',
      music_canonical_id: '777'
    })
    await assert.rejects(client.trackInfoByCanonicalId('888'), (error) => {
      assert.ok(error instanceof TrackNotFound)
      assert.equal(error.music_canonical_id, '888')
      return true
    })
  })
})

test('trackInfoById dan trackStreamInfoById mengirim body signed', async () => {
  const seen = []
  await withServer(recordingServer(seen, ok({ items: [] })), async (port) => {
    const client = loggedInClient(port)
    await client.trackInfoById('99', 'cur')
    await client.trackStreamInfoById('99', 'cur')
    assert.equal(seen[0].url.pathname, '/api/v1/clips/music/')
    assert.deepEqual(signedBody(seen[0].body), {
      audio_cluster_id: '99',
      original_sound_audio_asset_id: '99',
      max_id: 'cur'
    })
    assert.equal(seen[1].url.pathname, '/api/v1/clips/stream_clips_pivot_page/')
    assert.deepEqual(signedBody(seen[1].body), {
      pivot_page_type: 'audio',
      music_page: { tab_type: 'clips', audio_asset_id: '99', audio_cluster_id: '99', max_id: 'cur' },
      _uuid: 'uuid-1'
    })
  })
})

test('trackInfoById melempar TrackNotFound bila error tanpa JSON', async () => {
  const seen = []
  await withServer(recordingServer(seen, () => [404, 'not json']), async (port) => {
    const client = loggedInClient(port)
    await assert.rejects(client.trackInfoById('55'), (error) => {
      assert.ok(error instanceof TrackNotFound)
      assert.equal(error.original_sound_audio_asset_id, '55')
      assert.equal(error.music_canonical_id, undefined)
      return true
    })
  })
})

test('trackInfoById meneruskan error asli bila respons berisi JSON', async () => {
  const seen = []
  await withServer(recordingServer(seen, () => [400, JSON.stringify({ status: 'fail', message: 'bad' })]), async (port) => {
    const client = loggedInClient(port)
    await assert.rejects(client.trackInfoById('55'), (error) => {
      assert.ok(!(error instanceof TrackNotFound))
      return true
    })
  })
})
