import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Client, MediaError, UserError, ValidationError } from '../src/index.js'

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
  client.logger = { ...client.logger, error: () => {} }
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
    seen.push({ url: new URL(req.url, 'http://localhost'), body })
    const next = bodies.shift()
    res.writeHead(next.statusCode ?? 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(next.json ?? next))
  })
}

const signedBody = (body) => JSON.parse(decodeURIComponent(body.replace('signed_body=SIGNATURE.', '')))

const topPosts = (edges, endCursor, hasNextPage) => ({
  data: {
    shadow_instagram_user: {
      business_manager: {
        top_posts_unit: { top_posts: { edges, page_info: { end_cursor: endCursor, has_next_page: hasNextPage } } }
      }
    }
  }
})

test('insightsAccount mengirim surface account dan query_params yang benar', async () => {
  const seen = []
  const bodies = [{ data: { shadow_instagram_user: { business_manager: { account_summary: 1 } } } }]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const result = await client.insightsAccount()
    assert.deepEqual(result, { account_summary: 1 })
    assert.equal(seen[0].url.pathname, '/api/v1/ads/graphql/')
    const body = signedBody(seen[0].body)
    assert.equal(body.surface, 'account')
    assert.equal(body.doc_id, 2449243051851783)
    assert.equal(body.locale, 'en_US')
    assert.equal(body.vc_policy, 'insights_policy')
    assert.equal(body.strip_nulls, false)
    assert.equal(body.strip_defaults, false)
    const params = JSON.parse(body.query_params)
    assert.equal(params.IgInsightsGridMediaImage_SIZE, 360)
    assert.equal(params.activityTab, true)
    assert.deepEqual(params.query_params, { access_token: '', id: 123 })
  })
})

test('insightsAccount melempar UserError untuk akun non-bisnis', async () => {
  await withServer(jsonServer([], [{ data: { shadow_instagram_user: {} } }]), async (port) => {
    const client = loggedInClient(port)
    await assert.rejects(client.insightsAccount(), UserError)
  })
})

test('insightsMediaFeedAll mengikuti cursor dan memotong count', async () => {
  const seen = []
  const bodies = [topPosts([{ n: 1 }, { n: 2 }], 'c1', true), topPosts([{ n: 3 }], 'c2', true)]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const medias = await client.insightsMediaFeedAll({ count: 3, sleepSeconds: 0 })
    assert.deepEqual(medias, [{ n: 1 }, { n: 2 }, { n: 3 }])
    assert.equal(seen.length, 2)
    const first = signedBody(seen[0].body)
    assert.equal(first.surface, 'post_grid')
    assert.equal(first.doc_id, 2345520318892697)
    const firstParams = JSON.parse(first.query_params)
    assert.equal(firstParams.cursor, undefined)
    assert.equal(firstParams.count, 200)
    assert.equal(firstParams.dataOrdering, 'REACH_COUNT')
    assert.equal(firstParams.postType, 'ALL')
    assert.equal(firstParams.timeframe, 'TWO_YEARS')
    assert.deepEqual(firstParams.queryParams, { access_token: '', id: 123 })
    assert.equal(JSON.parse(signedBody(seen[1].body).query_params).cursor, 'c1')
  })
})

test('insightsMediaFeedAll memvalidasi pilihan dan login', async () => {
  const client = new Client({ requestTimeout: 0 })
  await assert.rejects(client.insightsMediaFeedAll({ postType: 'BOGUS' }), /post_type/)
  await assert.rejects(client.insightsMediaFeedAll({ timeFrame: 'BOGUS' }), /time_frame/)
  await assert.rejects(client.insightsMediaFeedAll({ dataOrdering: 'BOGUS' }), /data_ordering/)
  await assert.rejects(client.insightsMediaFeedAll(), ValidationError)
})

test('insightsMedia memakai media pk dan memetakan error ke MediaError', async () => {
  const seen = []
  const bodies = [
    { data: { instagram_post_by_igid: { id: '111', inline_insights_node: { metrics: {} } } } },
    { data: { instagram_post_by_igid: { id: '111' } } },
    { data: {} },
    { statusCode: 400, json: { status: 'fail', message: 'bad' } }
  ]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const media = await client.insightsMedia('111_9')
    assert.equal(media.id, '111')
    const body = signedBody(seen[0].body)
    assert.equal(body.surface, 'post')
    assert.equal(body.doc_id, 3221905377882880)
    assert.deepEqual(JSON.parse(body.query_params), { query_params: { access_token: '', id: '111' } })

    await assert.rejects(client.insightsMedia('111'), /without inline insights/)
    await assert.rejects(client.insightsMedia('111'), MediaError)
    await assert.rejects(client.insightsMedia('111'), (error) => error instanceof MediaError && error.media_pk === '111')
  })
})
