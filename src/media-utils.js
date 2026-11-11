import { readFile } from 'node:fs/promises'

export const loadBytes = async (input) => {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) return Buffer.from(input)
  if (typeof input === 'string') {
    if (/^https?:\/\//i.test(input)) {
      const res = await fetch(input)
      if (!res.ok) throw new Error(`Failed to download ${input}: ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    }
    return readFile(input)
  }
  if (input && typeof input === 'object') {
    if (input.url) return loadBytes(input.url)
    if (input.path) return loadBytes(input.path)
    if (input.stream) {
      const chunks = []
      for await (const chunk of input.stream) chunks.push(Buffer.from(chunk))
      return Buffer.concat(chunks)
    }
  }
  throw new TypeError('Unsupported media input, expected Buffer, path, URL or { url | path | stream }')
}

const isJpeg = (buffer) => buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8

export const prepareImage = async (buffer, { maxWidth = 1080, maxHeight = 1350 } = {}) => {
  let sharp = null
  try {
    sharp = (await import('sharp')).default
  } catch {
    sharp = null
  }
  if (!sharp) {
    if (isJpeg(buffer)) return buffer
    throw new Error('Install the optional dependency "sharp" to send non-JPEG images')
  }
  return sharp(buffer)
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize({ width: maxWidth, height: maxHeight, fit: 'inside', withoutEnlargement: true })
    .jpeg()
    .toBuffer()
}


const readBoxes = (buffer, start, end) => {
  const boxes = []
  let offset = start
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    let header = 8
    if (size === 1) {
      size = Number(buffer.readBigUInt64BE(offset + 8))
      header = 16
    } else if (size === 0) {
      size = end - offset
    }
    if (size < header || offset + size > end) break
    boxes.push({ type, start: offset + header, end: offset + size })
    offset += size
  }
  return boxes
}

const findBox = (buffer, boxes, type) => boxes.find((box) => box.type === type)

export const readMp4Metadata = (buffer, fallback = { width: 720, height: 1280, duration: 1 }) => {
  try {
    const top = readBoxes(buffer, 0, buffer.length)
    const moov = findBox(buffer, top, 'moov')
    if (!moov) return fallback
    const children = readBoxes(buffer, moov.start, moov.end)
    let duration = null
    const mvhd = findBox(buffer, children, 'mvhd')
    if (mvhd) {
      const version = buffer[mvhd.start]
      if (version === 1) {
        const timescale = buffer.readUInt32BE(mvhd.start + 20)
        duration = Number(buffer.readBigUInt64BE(mvhd.start + 24)) / timescale
      } else {
        const timescale = buffer.readUInt32BE(mvhd.start + 12)
        duration = buffer.readUInt32BE(mvhd.start + 16) / timescale
      }
    }
    let best = null
    for (const trak of children.filter((box) => box.type === 'trak')) {
      const trakChildren = readBoxes(buffer, trak.start, trak.end)
      const tkhd = findBox(buffer, trakChildren, 'tkhd')
      if (!tkhd) continue
      const version = buffer[tkhd.start]
      const widthOffset = tkhd.start + (version === 1 ? 88 : 76)
      const width = buffer.readUInt32BE(widthOffset) / 65536
      const height = buffer.readUInt32BE(widthOffset + 4) / 65536
      const mdia = findBox(buffer, trakChildren, 'mdia')
      let handler = ''
      if (mdia) {
        const hdlr = findBox(buffer, readBoxes(buffer, mdia.start, mdia.end), 'hdlr')
        if (hdlr) handler = buffer.toString('latin1', hdlr.start + 8, hdlr.start + 12)
      }
      if (width && height && (handler === 'vide' || !best)) best = { width, height }
      if (handler === 'vide') break
    }
    if (!best) return fallback
    return { width: Math.round(best.width), height: Math.round(best.height), duration: duration || fallback.duration }
  } catch {
    return fallback
  }
}
