import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Client, ClientError } from '../src/index.js'
import {
  crosspostingCandidateValue,
  crosspostingGraphqlRoot,
  crosspostingHasGraphqlRoot,
  crosspostingValidationBypass,
  fbConnectedServicesDestinationCandidates,
  mediaShareToFbFeedCandidate,
  mediaShareToFbUnifiedDestinationCandidates
} from '../src/mixins/crossposting.js'

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
    seen.push({ url: new URL(req.url, 'http://localhost'), body, headers: req.headers })
    const [status, payload] = respond(seen.length)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(payload)
  })
}

const json = (data, status = 200) => () => [status, JSON.stringify(data)]
const formBody = (body) => Object.fromEntries(new URLSearchParams(body))

const connectedServices = (destinations, extra = {}) => ({
  data: {
    fx_service_cache: {
      services: [{ ...extra, identity_mapping: [{ destination_identities: destinations }] }]
    }
  }
})

test('crosspostingValidationBypass meniru normalisasi Python', () => {
  assert.equal(crosspostingValidationBypass(null), null)
  assert.equal(crosspostingValidationBypass(''), null)
  assert.equal(crosspostingValidationBypass([]), null)
  assert.deepEqual(crosspostingValidationBypass('["a",1]'), ['a', '1'])
  assert.deepEqual(crosspostingValidationBypass('reason'), ['reason'])
  assert.deepEqual(crosspostingValidationBypass(new Set(['x'])), ['x'])
  assert.deepEqual(crosspostingValidationBypass(5), ['5'])
  assert.deepEqual(crosspostingValidationBypass(true), ['True'])
})

test('crosspostingCandidateValue melewati None dan string kosong', () => {
  assert.equal(crosspostingCandidateValue({ a: '', b: null, c: 0 }, ['a', 'b', 'c']), 0)
  assert.equal(crosspostingCandidateValue({}, ['a']), null)
})

test('crosspostingGraphqlRoot dan crosspostingHasGraphqlRoot mencari root di data lalu di config', () => {
  assert.deepEqual(crosspostingGraphqlRoot({ data: { root: { x: 1 } } }, 'root'), { x: 1 })
  assert.deepEqual(crosspostingGraphqlRoot({ data: { xdt_root_v2: [1] } }, 'root'), [1])
  assert.deepEqual(crosspostingGraphqlRoot({ root: 2 }, 'root'), 2)
  assert.deepEqual(crosspostingGraphqlRoot({ other: 1 }, 'root'), { other: 1 })
  assert.deepEqual(crosspostingGraphqlRoot(null, 'root'), {})
  assert.equal(crosspostingHasGraphqlRoot({ data: { a_root: null } }, 'root'), true)
  assert.equal(crosspostingHasGraphqlRoot({ root: 1 }, 'root'), true)
  assert.equal(crosspostingHasGraphqlRoot({ data: {} }, 'root'), false)
  assert.equal(crosspostingHasGraphqlRoot([], 'root'), false)
})

test('mediaShareToFbFeedCandidate hanya menerima surface FEED ke Facebook', () => {
  assert.equal(mediaShareToFbFeedCandidate({ source_surface: 'feed' }), true)
  assert.equal(mediaShareToFbFeedCandidate({ destination_surface: 'FEED', destination_app: 'facebook' }), true)
  assert.equal(mediaShareToFbFeedCandidate({ source_surface: 'STORY' }), false)
  assert.equal(mediaShareToFbFeedCandidate({ source_surface: 'FEED', destination_app: 'THREADS' }), false)
  assert.equal(mediaShareToFbFeedCandidate({ destination_app: 'FB' }), false)
})

test('mediaShareToFbUnifiedDestinationCandidates mengambil identity dan kandidat bersarang', () => {
  const config = {
    data: {
      xcxp_unified_crossposting_configs_root: [
        {
          custom_service_data: { source_surface: 'FEED' },
          identity_mapping: [{ destination_identities: [{ obfuscated_identity_id: 'fb-1', identity_type: 'USER' }, 'x'] }]
        },
        { source_surface: 'FEED', destination: { destination_id: 'fb-2', destination_type: 'PAGE' } }
      ]
    }
  }
  const candidates = [...mediaShareToFbUnifiedDestinationCandidates(config)]
  assert.deepEqual(candidates[0], {
    source_surface: 'FEED',
    destination_app: 'FB',
    destination_surface: 'FEED',
    obfuscated_identity_id: 'fb-1',
    identity_type: 'USER'
  })
  const nested = candidates.find((candidate) => candidate.destination_id === 'fb-2')
  assert.equal(nested.destination_type, 'PAGE')
})

test('fbConnectedServicesDestinationCandidates melewati tujuan tidak eligible dan membawa audience reels', () => {
  const config = connectedServices(
    [
      { id: 'a', surface_to_xpost_eligibilities: [{ surface: 'feed', is_eligible: false }] },
      { id: 'b', surface_to_xpost_eligibilities: [{ surface: 'REELS', is_eligible: false }] }
    ],
    { custom_service_data: { fb_reels_privacy_setting_service_data: { fb_reels_audience: 'FRIENDS' } } }
  )
  const feed = [...fbConnectedServicesDestinationCandidates(config, 'feed')]
  assert.deepEqual(feed.map((candidate) => candidate.id), ['b'])
  assert.equal(feed[0].destination_audience_type, undefined)
  const reels = [...fbConnectedServicesDestinationCandidates(config, 'REELS')]
  assert.deepEqual(reels.map((candidate) => candidate.id), ['a'])
  assert.equal(reels[0].destination_audience_type, 'FRIENDS')
  assert.deepEqual([...fbConnectedServicesDestinationCandidates({ data: { fx_service_cache: [] } }, 'FEED')], [])
})

test('mediaShareToFbDestination memakai config eksplisit dan memvalidasi tipe', async () => {
  const client = new Client({ requestTimeout: 0 })
  assert.deepEqual(
    await client.mediaShareToFbDestination({
      config: { share_to_fb_destination_id: 10, identity_type: 'FB_page', validation_bypass: '["r"]' }
    }),
    { destination_id: '10', destination_type: 'PAGE', validation_bypass: ['r'] }
  )
  assert.deepEqual(
    await client.mediaShareToFbDestination({ destinationId: '1', destinationType: 'user' }),
    { destination_id: '1', destination_type: 'USER' }
  )
  await assert.rejects(client.mediaShareToFbDestination({ config: { enabled: false } }), /not enabled/)
  await assert.rejects(client.mediaShareToFbDestination({ destinationType: 'USER' }), /has no destination\./)
  await assert.rejects(client.mediaShareToFbDestination({ destinationId: '1' }), /no destination type/)
  await assert.rejects(client.mediaShareToFbDestination({ destinationId: '1', destinationType: 'GROUP' }), /USER or PAGE/)
})

test('mediaShareToFbDestination menyelesaikan config connected services', async () => {
  const client = new Client({ requestTimeout: 0 })
  const config = connectedServices([{ obfuscated_identity_id: 'fb-9', identity_type: 'USER' }])
  assert.deepEqual(await client.mediaShareToFbDestination({ config }), { destination_id: 'fb-9', destination_type: 'USER' })
  await assert.rejects(
    client.mediaShareToFbDestination({ config: connectedServices([{ identity_type: 'USER' }]) }),
    (error) => error instanceof ClientError && /no eligible Feed destination/.test(error.message)
  )
})

test('mediaShareToFbUnifiedConfig mengirim CrosspostingUnifiedConfigsQuery ke i.instagram.com/graphql_www', async () => {
  const seen = []
  const targets = []
  await withServer(recordingServer(seen, json({ data: {} })), async (port) => {
    const client = loggedInClient(port, targets)
    const result = await client.mediaShareToFbUnifiedConfig()
    assert.equal(result.status, 'ok')
    assert.equal(targets[0].url, 'https://i.instagram.com/graphql_www')
    const body = formBody(seen[0].body)
    assert.equal(body.fb_api_req_friendly_name, 'CrosspostingUnifiedConfigsQuery')
    assert.equal(body.client_doc_id, '216179630714134719310007237117')
    assert.equal('purpose' in body, false)
    assert.deepEqual(JSON.parse(body.variables), {
      configs_request: {
        source_app: 'IG',
        crosspost_app_surface_list: [
          { source_surface: 'STORY', destination_app: 'FB', destination_surface: 'STORY' },
          { source_surface: 'FEED', destination_app: 'FB', destination_surface: 'FEED' },
          { source_surface: 'REELS', destination_app: 'FB', destination_surface: 'REELS' }
        ]
      }
    })
    assert.equal(seen[0].headers['x-root-field-name'], 'xcxp_unified_crossposting_configs_root')
    assert.equal(seen[0].headers.priority, 'u=3, i')
    assert.equal(seen[0].headers['x-fb-rmd'], 'state=URL_ELIGIBLE')
  })
})

test('mediaShareToFbExtraData mencoba unified config, varian FEED, lalu connected services', async () => {
  const seen = []
  const responses = [
    json({ data: { xcxp_unified_crossposting_configs_root: {} } }),
    json({ data: { xcxp_unified_crossposting_configs_root: {} } }),
    json(connectedServices([{ obfuscated_identity_id: 'fb-5', identity_type: 'USER' }]))
  ]
  await withServer(recordingServer(seen, (n) => responses[n - 1]()), async (port) => {
    const client = loggedInClient(port)
    const data = await client.mediaShareToFbExtraData({ attemptId: 'attempt-1' })
    assert.deepEqual(data, {
      share_to_facebook: '1',
      share_to_fb_destination_id: 'fb-5',
      share_to_fb_destination_type: 'USER',
      no_token_crosspost: '1',
      attempt_id: 'attempt-1'
    })
    assert.equal(seen.length, 3)
    assert.deepEqual(JSON.parse(formBody(seen[1].body).variables).configs_request.crosspost_app_surface_list, [
      { source_surface: 'FEED', destination_app: 'FB', destination_surface: 'FEED' }
    ])
    const third = formBody(seen[2].body)
    assert.equal(third.fb_api_req_friendly_name, 'FxIgConnectedServicesInfoQuery')
    assert.equal(third.client_doc_id, '21631519911413744205623093060')
    assert.equal(seen[2].headers['x-root-field-name'], 'fx_service_cache')
  })
})

test('mediaShareToThreadsConfig jatuh ke graphql/query saat ClientGraphqlError', async () => {
  const seen = []
  const responses = [
    json({ errors: [{ message: 'no' }] }),
    json({ data: { xcxp_fetch_linked_threads_profile: { id: 't-1', username: 'me', profile_pic_url: '' } } })
  ]
  await withServer(recordingServer(seen, (n) => responses[n - 1]()), async (port) => {
    const client = loggedInClient(port)
    const data = await client.mediaShareToThreadsExtraData({ validationBypass: ['x'] })
    assert.deepEqual(data, {
      share_to_threads: '1',
      share_to_threads_destination_id: 't-1',
      share_to_threads_validation_bypass: ['x']
    })
    assert.equal(seen[0].url.pathname, '/graphql_www')
    assert.equal(seen[1].url.pathname, '/graphql/query')
    assert.equal(formBody(seen[1].body).fb_api_req_friendly_name, 'LinkedBarcelonaProfileQuery')
    assert.equal(seen[1].headers['x-root-field-name'], 'xcxp_fetch_linked_threads_profile')
    assert.equal(seen[1].headers['x-fb-rmd'], 'state=URL_ELIGIBLE')
  })
})

test('mediaShareToThreadsDestination memakai id eksplisit tanpa request dan menolak profil kosong', async () => {
  const client = new Client({ requestTimeout: 0 })
  assert.deepEqual(await client.mediaShareToThreadsDestination({ destinationId: 77 }), { destination_id: '77' })
  assert.deepEqual(
    await client.mediaShareToThreadsDestination({
      config: { data: { xcxp_fetch_linked_threads_profile: { strong_id__: 's-1', username: 'u' } } }
    }),
    { destination_id: 's-1', username: 'u' }
  )
  await assert.rejects(
    client.mediaShareToThreadsDestination({ config: { data: { xcxp_fetch_linked_threads_profile: null } } }),
    /no linked Threads profile/
  )
})
