import test from 'node:test'
import assert from 'node:assert/strict'
import { Client, ValidationError } from '../src/index.js'

test('shareInfo mendekode kode share persis seperti Python', () => {
  const client = new Client({ requestTimeout: 0 })
  const info = client.shareInfo('aGlnaGxpsdsdZ2h0OjE3OTg4MDg5NjI5MzgzNzcw')
  assert.deepEqual(info, { type: 'highlight', pk: '17988089629383770' })
})

test('shareInfo menerima Buffer berisi teks base64', () => {
  const client = new Client({ requestTimeout: 0 })
  const buffer = Buffer.from('c3Rvcnk6MTc5ODgwODk2MjkzODM3NzA=')
  assert.deepEqual(client.shareInfo(buffer), { type: 'story', pk: '17988089629383770' })
})

test('shareInfoByUrl mengambil kode dari path lalu mendekodenya', () => {
  const client = new Client({ requestTimeout: 0 })
  assert.deepEqual(client.shareInfoByUrl('https://www.instagram.com/p/aGlnaGxpsdsdZ2h0OjE3OTg4MDg5NjI5MzgzNzcw/'), {
    type: 'highlight',
    pk: '17988089629383770'
  })
})

test('shareCodeFromUrl mengabaikan query, fragment, dan slash akhir', () => {
  const client = new Client({ requestTimeout: 0 })
  assert.equal(
    client.shareCodeFromUrl('https://www.instagram.com/stories/user/123/?igsh=abc#x'),
    '123'
  )
  assert.equal(client.shareCodeFromUrl('/p/ABC123/'), 'ABC123')
})

test('shareInfo menolak kode yang tidak valid', () => {
  const client = new Client({ requestTimeout: 0 })
  assert.throws(() => client.shareInfo('aGVsbG8='), ValidationError)
  assert.throws(() => client.shareInfo(null), ValidationError)
  assert.throws(() => client.shareInfo(123), ValidationError)
})
