import { Readable } from 'node:stream'
import { fetch } from 'undici'
import { getContentType, normalizeMessageContent } from './messages.js'

const urlFromContent = (content) => {
  const type = getContentType(content)
  if (!type) return null
  const body = content[type]
  if (type === 'mediaShareMessage') return body.videoUrl ?? body.thumbnailUrl ?? null
  if (type === 'reelShareMessage' || type === 'storyShareMessage') {
    const inner = body.media
    const innerType = getContentType(inner)
    return innerType ? inner[innerType].url : null
  }
  if (type === 'profileMessage') return body.pictureUrl ?? null
  return body.url ?? null
}

export const downloadMediaMessage = async (message, type = 'buffer', options = {}) => {
  const content = normalizeMessageContent(message?.message ?? message)
  const url = urlFromContent(content)
  if (!url) throw new Error('Message has no downloadable media')
  const response = await fetch(url, { signal: options.signal, headers: options.headers })
  if (!response.ok) throw new Error(`Download failed: ${response.status}`)
  if (type === 'stream') return Readable.fromWeb(response.body)
  return Buffer.from(await response.arrayBuffer())
}

export const downloadContentFromMessage = async (content, type = 'stream') =>
  downloadMediaMessage({ message: content }, type === 'buffer' ? 'buffer' : 'stream')
