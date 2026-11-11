import test from 'node:test'
import assert from 'node:assert/strict'
import { readMp4Metadata } from '../src/media-utils.js'

const box = (type, payload) => {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(8 + payload.length, 0)
  header.write(type, 4, 'latin1')
  return Buffer.concat([header, payload])
}

const mvhd = (timescale, duration) => {
  const payload = Buffer.alloc(100)
  payload.writeUInt32BE(timescale, 12)
  payload.writeUInt32BE(duration, 16)
  return box('mvhd', payload)
}

const trak = (handler, width, height) => {
  const tkhd = Buffer.alloc(84)
  tkhd.writeUInt32BE(width * 65536, 76)
  tkhd.writeUInt32BE(height * 65536, 80)
  const hdlr = Buffer.alloc(24)
  hdlr.write(handler, 8, 'latin1')
  return box('trak', Buffer.concat([box('tkhd', tkhd), box('mdia', box('hdlr', hdlr))]))
}

test('readMp4Metadata membaca dimensi dan durasi dari track video', () => {
  const file = Buffer.concat([
    box('ftyp', Buffer.from('isom0000', 'latin1')),
    box('moov', Buffer.concat([mvhd(1000, 12500), trak('soun', 0, 0), trak('vide', 1080, 1920)]))
  ])
  assert.deepEqual(readMp4Metadata(file), { width: 1080, height: 1920, duration: 12.5 })
})

test('readMp4Metadata memakai fallback untuk data yang bukan MP4', () => {
  assert.deepEqual(readMp4Metadata(Buffer.from('bukan mp4')), { width: 720, height: 1280, duration: 1 })
})
