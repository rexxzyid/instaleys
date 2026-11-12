import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  ChallengeRequired,
  Client,
  ClientGraphqlError,
  ClientThrottledError,
  LoginRequired,
  ValidationError
} from '../src/index.js'

const withServer = async (handler, run) => {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(server.address().port)
  } finally {
    server.close()
  }
}

const loggedInClient = (port, targets = []) => {
  const client = new Client({ requestTimeout: 0 })
  client.authorizationData = { ds_user_id: '123', sessionid: '123%3Aabcdefghijklmnopqrstuvwxyz0123456789' }
  client.uuid = 'uuid-1'
  client.logger = { ...client.logger, error: () => {} }
  const origin = `http://127.0.0.1:${port}`
  const realRequest = client.private.request.bind(client.private)
  client.private.request = (method, url, opts) => {
    targets.push({ url, headers: opts.headers })
    return realRequest(method, url.replace(/^https:\/\/[^/]+/, origin), opts)
  }
  return client
}

const recordingServer = (seen, respond) => (req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    seen.push({ url: new URL(req.url, 'http://localhost'), method: req.method, body, headers: req.headers })
    const [status, payload] = respond(seen.length)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(payload)
  })
}

const json = (data, status = 200) => () => [status, JSON.stringify(data)]
const formBody = (body) => Object.fromEntries(new URLSearchParams(body))
const signedBody = (body) => JSON.parse(decodeURIComponent(body.replace('signed_body=SIGNATURE.', '')))

test('standaloneFundraiserInfoV1 memakai GET ke endpoint fundraiser', async () => {
  const seen = []
  await withServer(recordingServer(seen, json({ status: 'ok', fundraiser: {} })), async (port) => {
    const client = loggedInClient(port)
    const result = await client.standaloneFundraiserInfoV1(42)
    assert.deepEqual(result.fundraiser, {})
    assert.equal(seen[0].method, 'GET')
    assert.equal(seen[0].url.pathname, '/api/v1/fundraiser/42/standalone_fundraiser_info/')
  })
})

test('privateGraphqlWwwRequest mengirim form, header, dan domain b.i.instagram.com', async () => {
  const seen = []
  const targets = []
  await withServer(recordingServer(seen, json({ data: { ok: true } })), async (port) => {
    const client = loggedInClient(port, targets)
    const result = await client.privateGraphqlWwwRequest({
      friendlyName: 'Q',
      variables: { a: 1 },
      clientDocId: 99,
      extraHeaders: { 'X-Extra': 'x' }
    })
    assert.deepEqual(result, { data: { ok: true } })
    assert.equal(targets[0].url, 'https://b.i.instagram.com/graphql_www')
    assert.equal(targets[0].headers.Host, 'b.i.instagram.com')
    assert.equal(seen[0].url.pathname, '/graphql_www')
    assert.equal(seen[0].headers['x-fb-friendly-name'], 'Q')
    assert.equal(seen[0].headers['x-client-doc-id'], '99')
    assert.equal(seen[0].headers['x-extra'], 'x')
    assert.match(seen[0].headers.authorization, /^Bearer IGT:2:/)
    assert.deepEqual(formBody(seen[0].body), {
      method: 'post',
      pretty: 'false',
      format: 'json',
      server_timestamps: 'true',
      locale: 'user',
      fb_api_req_friendly_name: 'Q',
      enable_canonical_naming: 'true',
      enable_canonical_variable_overrides: 'true',
      enable_canonical_naming_ambiguous_type_prefixing: 'true',
      variables: '{"a":1}',
      purpose: 'fetch',
      client_doc_id: '99'
    })
  })
})

test('privateGraphqlWwwRequest tanpa purpose bila null dan melempar ClientGraphqlError pada errors', async () => {
  const seen = []
  const responses = [json({ data: {} }), json({ errors: [{ message: 'x' }] })]
  await withServer(recordingServer(seen, (n) => responses[n - 1]()), async (port) => {
    const client = loggedInClient(port)
    await client.privateGraphqlWwwRequest({ friendlyName: 'Q', purpose: null })
    assert.equal('purpose' in formBody(seen[0].body), false)
    assert.equal(formBody(seen[0].body).variables, '{}')
    await assert.rejects(client.privateGraphqlWwwRequest({ friendlyName: 'Q' }), ClientGraphqlError)
  })
})

test('privateGraphqlWwwRequest memetakan error HTTP seperti _raise_graphql_http_error', async () => {
  const seen = []
  const responses = [
    json({ message: 'login_required' }, 403),
    json({ message: 'challenge_required' }, 400),
    json({ status: 'fail' }, 429),
    () => [404, 'Not Found']
  ]
  await withServer(recordingServer(seen, (n) => responses[n - 1]()), async (port) => {
    const client = loggedInClient(port)
    await assert.rejects(client.privateGraphqlWwwRequest({ friendlyName: 'Q' }), LoginRequired)
    assert.equal(client.lastJson.message, 'login_required')
    await assert.rejects(client.privateGraphqlWwwRequest({ friendlyName: 'Q' }), ChallengeRequired)
    await assert.rejects(client.privateGraphqlWwwRequest({ friendlyName: 'Q' }), ClientThrottledError)
    await assert.rejects(client.privateGraphqlWwwRequest({ friendlyName: 'Q' }), ChallengeRequired)
  })
})

test('quicksnapHistory mengirim variables dan mengambil quick_snap_paginated_history', async () => {
  const seen = []
  const history = { edges: [{ node: { id: '1' } }], page_info: { end_cursor: 'c2', has_next_page: true } }
  const responses = [
    json({ data: { viewer: { xdt_quick_snap_paginated_history_abc: history } } }),
    json({ data: { viewer: {} } })
  ]
  await withServer(recordingServer(seen, (n) => responses[n - 1]()), async (port) => {
    const client = loggedInClient(port)
    assert.deepEqual(await client.quicksnapHistory(5, 'c1'), history)
    const body = formBody(seen[0].body)
    assert.equal(body.fb_api_req_friendly_name, 'IGQuickSnapGetHistoryPaginatedQuery')
    assert.equal(body.client_doc_id, '202528380816979569862257718136')
    assert.equal(body.variables, '{"first":5,"after":"c1"}')
    assert.equal(body.purpose, 'fetch')
    await assert.rejects(client.quicksnapHistory(), ClientGraphqlError)
    assert.equal(formBody(seen[1].body).variables, '{"first":20}')
  })
})

test('quicksnapDelete mengirim soft_delete dan membaca did_delete', async () => {
  const seen = []
  const responses = [json({ status: 'ok', did_delete: true }), json({ status: 'ok' })]
  await withServer(recordingServer(seen, (n) => responses[n - 1]()), async (port) => {
    const client = loggedInClient(port)
    assert.equal(await client.quicksnapDelete(777), true)
    assert.equal(await client.quicksnapDelete('778'), false)
    assert.equal(seen[0].url.pathname, '/api/v1/media/777/soft_delete/')
    assert.deepEqual(signedBody(seen[0].body), { media_id: '777', _uuid: 'uuid-1' })
  })
})

test('quicksnap butuh login', async () => {
  const client = new Client({ requestTimeout: 0 })
  await assert.rejects(client.quicksnapHistory(), ValidationError)
  await assert.rejects(client.quicksnapDelete('1'), ValidationError)
})

test('helper private graphql query mengirim friendly name, root field, dan doc id dari sumber', async () => {
  const seen = []
  await withServer(recordingServer(seen, json({ data: {} })), async (port) => {
    const client = loggedInClient(port)
    await client.privateGraphqlMemoriesPog(undefined, 'region-1')
    await client.privateGraphqlRealtimeRegionHint()
    await client.privateGraphqlTopAudioTrendsEligibleCategories()
    await client.privateGraphqlUpdateInboxTrayLastSeen()
    const expected = [
      ['MemoriesPogQuery', 'xdt_get_story_memories_pog', '4160563056814166588457451196', '{"request":{"user_id":0}}'],
      ['IGRealtimeRegionHintQuery', 'xdt_igd_msg_region', '52232106018313849661757113193', '{}'],
      ['GetTopAudioTrendsEligibleCategories', 'xdt_top_audio_trends_eligible_tabs', '10243243298540497152200027985', '{}'],
      ['UpdateInboxTrayLastSeenTimestamp', '__typename', '41048505499858972910914091441', '{}']
    ]
    expected.forEach(([friendlyName, rootField, docId, variables], index) => {
      const request = seen[index]
      const body = formBody(request.body)
      assert.equal(request.url.pathname, '/graphql/query')
      assert.equal(body.fb_api_req_friendly_name, friendlyName)
      assert.equal(body.client_doc_id, docId)
      assert.equal(body.variables, variables)
      assert.equal(request.headers['x-root-field-name'], rootField)
      assert.equal(request.headers['x-client-doc-id'], docId)
    })
    assert.equal(seen[0].headers['ig-u-ig-direct-region-hint'], 'region-1')
    assert.equal(seen[1].headers.priority, 'u=3, i')
    assert.equal(seen[2].headers.priority, 'u=3')
  })
})
