import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Client, ClientGraphqlError, ValidationError } from '../src/index.js'
import { SUPPORTED_CAPABILITIES } from '../src/config.js'

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
  client.phoneId = 'phone-id'
  client.uuid = 'uuid-1'
  client.clientSessionId = 'session-1'
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
    res.end(bodies.shift())
  })
}

const formOf = (body) => Object.fromEntries(new URLSearchParams(body))

test('getNotes memakai endpoint graphql/query dan memetakan note dict', async () => {
  const seen = []
  const bodies = [
    JSON.stringify({
      data: {
        xdt_get_inbox_tray_items: {
          inbox_tray_items: [
            {
              inbox_tray_item_id: 'note-1',
              note_dict: {
                note_id: 'note-1',
                text: 'halo',
                author_id: '55',
                '1lcreated_at': 1700000000,
                audience: 1,
                note_style: 0,
                is_emoji_only: true
              },
              pog_info: { pog_users: [{ id: '55', username: 'alice', full_name: 'Alice' }] }
            },
            { inbox_tray_item_id: 'note-2' }
          ]
        }
      }
    })
  ]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const notes = await client.getNotes()
    assert.equal(notes.length, 1)
    assert.equal(notes[0].id, 'note-1')
    assert.equal(notes[0].text, 'halo')
    assert.equal(notes[0].user_id, '55')
    assert.equal(notes[0].user.username, 'alice')
    assert.equal(notes[0].audience, 1)
    assert.equal(notes[0].is_emoji_only, true)
    assert.equal(notes[0].created_at.getTime(), 1700000000000)
    assert.equal(notes[0].expires_at.getTime(), 1700000000000 + 86400000)
    assert.equal(client.getNoteTextByUser(notes, 'ALICE'), 'halo')

    assert.equal(seen[0].url.pathname, '/graphql/query')
    const body = formOf(seen[0].body)
    assert.equal(body.fb_api_req_friendly_name, 'InboxTrayRequest')
    assert.equal(body.client_doc_id, '26838444193647008103482058049')
    const variables = JSON.parse(body.variables)
    assert.deepEqual(variables.request.inbox_tray_item_ids_on_client, [])
    assert.equal(seen[0].headers['x-root-field-name'], 'xdt_get_inbox_tray_items')
    assert.equal(seen[0].headers['x-client-doc-id'], '26838444193647008103482058049')
    assert.equal(seen[0].headers.priority, 'u=3, i')
  })
})

test('getNotes melempar ClientGraphqlError bila root field tidak ada', async () => {
  await withServer(
    jsonServer([], [JSON.stringify({ data: { other: {} } })]),
    async (port) => {
      const client = loggedInClient(port)
      await assert.rejects(client.getNotes(), ClientGraphqlError)
    }
  )
})

test('lastSeenUpdateNote dan deleteNote memakai endpoint dan body yang benar', async () => {
  const seen = []
  const bodies = [JSON.stringify({ status: 'ok' }), JSON.stringify({ status: 'nok' })]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    assert.equal(await client.lastSeenUpdateNote(), true)
    assert.equal(seen[0].url.pathname, '/api/v1/notes/update_notes_last_seen_timestamp/')
    const body = JSON.parse(decodeURIComponent(seen[0].body.replace('signed_body=SIGNATURE.', '')))
    assert.equal(body._uuid, 'uuid-1')

    assert.equal(await client.deleteNote(77), false)
    assert.equal(seen[1].url.pathname, '/api/v1/notes/delete_note/')
    const del = JSON.parse(decodeURIComponent(seen[1].body.replace('signed_body=SIGNATURE.', '')))
    assert.equal(del.id, 77)
    assert.equal(del._uuid, 'uuid-1')
  })
})

test('notesMusicBrowser memakai withSignature false dan melempar bila gagal', async () => {
  const seen = []
  const bodies = [JSON.stringify({ status: 'ok', alacorn_session_id: 'alacorn-1' }), JSON.stringify({ status: 'nope' })]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const browser = await client.notesMusicBrowser()
    assert.equal(browser.alacorn_session_id, 'alacorn-1')
    assert.equal(seen[0].url.pathname, '/api/v1/music/notes_audio_browser/')
    assert.equal(seen[0].body, 'product=music_notes&_uuid=uuid-1')
    await assert.rejects(client.notesMusicBrowser(), ClientGraphqlError)
  })
})

test('createNote memvalidasi audience dan mengirim data yang benar', async () => {
  const seen = []
  const bodies = [JSON.stringify({ status: 'ok', note_id: 'n1', text: 'hi' })]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const note = await client.createNote('hi', { audience: 'CLOSE_FRIENDS' })
    assert.equal(note.note_id, 'n1')
    assert.equal(note.status, undefined)
    const body = JSON.parse(decodeURIComponent(seen[0].body.replace('signed_body=SIGNATURE.', '')))
    assert.equal(body.note_style, 0)
    assert.equal(body.text, 'hi')
    assert.equal(body.audience, 1)
    assert.equal(body._uuid, 'uuid-1')
    assert.equal(seen[0].url.pathname, '/api/v1/notes/create_note')

    await assert.rejects(client.createNote('x', { audience: 'bogus' }), ValidationError)
  })
})

test('createMusicNote memakai alacorn dari browser saat tidak diberikan', async () => {
  const seen = []
  const bodies = [
    JSON.stringify({ status: 'ok', alacorn_session_id: 'alacorn-9' }),
    JSON.stringify({
      data: {
        create_inbox_tray_item: {
          success: true,
          inbox_tray_item: {
            note_dict: {
              note_id: 'music-note',
              text: 'lagu',
              author_id: '123',
              '1lcreated_at': 1700000000,
              audience: 0
            }
          }
        }
      }
    })
  ]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const note = await client.createMusicNote(
      { audio_cluster_id: 42, audio_asset_id: 'asset-1', highlight_start_times_in_ms: [1500] },
      'lagu'
    )
    assert.equal(note.id, 'music-note')
    const body = formOf(seen[1].body)
    assert.equal(body.fb_api_req_friendly_name, 'CreateInboxTrayItemRequest')
    assert.equal(body.client_doc_id, '3510400299951610199199089856')
    const variables = JSON.parse(body.variables)
    const info = variables.request.additional_params.note_create_params.note_create_info.music_note_create_info
    assert.equal(info.audio_asset_id, 'asset-1')
    assert.equal(info.audio_cluster_id, '42')
    assert.equal(info.start_time, 1500)
    assert.equal(info.duration, 30000)
    assert.equal(info.alacorn_session_id, 'alacorn-9')
    assert.equal(variables.request.additional_params.note_create_params.note_style, 1)
  })
})

test('createMusicNote memvalidasi track dan audience', async () => {
  const client = new Client({ requestTimeout: 0 })
  await assert.rejects(client.createMusicNote({ id: 'a' }), ValidationError)
  await assert.rejects(client.createMusicNote({}, '', { audience: 0 }), ValidationError)
  await assert.rejects(client.createMusicNote({ id: 'a', audio_cluster_id: 1 }, '', { audience: 99 }), ValidationError)
})

test('privateGraphqlQueryRequest mendukung baris streaming bertahap', async () => {
  const seen = []
  const bodies = [
    `${JSON.stringify({ data: { x: { a: 1 } } })}\n${JSON.stringify({ path: ['x', 'b'], data: 2 })}\n`
  ]
  await withServer(jsonServer(seen, bodies), async (port) => {
    const client = loggedInClient(port)
    const result = await client.privateGraphqlQueryRequest({
      friendlyName: 'Test',
      rootFieldName: 'xdt_test',
      variables: {}
    })
    assert.deepEqual(result.data.x, { a: 1, b: 2 })
  })
})