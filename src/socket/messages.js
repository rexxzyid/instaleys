import { randomBytes } from 'node:crypto'
import { userJid } from './jid.js'

const META_KEYS = new Set(['messageContextInfo', 'senderKeyDistributionMessage'])

export const generateMessageID = () => `IG${randomBytes(10).toString('hex').toUpperCase()}`

export const getContentType = (content) => {
  if (!content || typeof content !== 'object') return undefined
  return Object.keys(content).find((key) => !META_KEYS.has(key) && content[key] !== undefined && content[key] !== null)
}

export const normalizeMessageContent = (content) => {
  let current = content
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const inner = current.viewOnceMessage?.message ?? current.ephemeralMessage?.message
    if (!inner) break
    current = inner
  }
  return current
}

export const extractMessageContent = normalizeMessageContent

export const getMessageText = (message) => {
  const content = normalizeMessageContent(message)
  if (!content) return ''
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.mediaShareMessage?.caption ??
    content.reelShareMessage?.text ??
    content.storyShareMessage?.text ??
    ''
  )
}

export const toSeconds = (value) => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? Math.floor(Date.now() / 1000) : Math.floor(value.getTime() / 1000)
  }
  if (typeof value === 'number') return value > 1e14 ? Math.floor(value / 1e6) : value > 1e11 ? Math.floor(value / 1e3) : value
  if (typeof value === 'string' && /^\d+$/.test(value)) return toSeconds(Number(value))
  return Math.floor(Date.now() / 1000)
}

const largest = (items = []) =>
  [...items].sort((a, b) => (a.width ?? 0) * (a.height ?? 0) - (b.width ?? 0) * (b.height ?? 0)).at(-1)

const imageUrl = (media) =>
  media?.thumbnail_url ?? largest(media?.image_versions2?.candidates)?.url ?? null

const videoUrl = (media) => media?.video_url ?? largest(media?.video_versions)?.url ?? null

const mediaContent = (media, caption = '') => {
  if (!media) return null
  const dims = {
    width: media.original_width ?? largest(media.image_versions2?.candidates)?.width,
    height: media.original_height ?? largest(media.image_versions2?.candidates)?.height
  }
  if (media.media_type === 2 || media.video_versions?.length || media.video_url) {
    return {
      videoMessage: {
        url: videoUrl(media),
        thumbnailUrl: imageUrl(media),
        mimetype: 'video/mp4',
        seconds: Math.round(media.video_duration ?? 0),
        caption,
        ...dims
      }
    }
  }
  return { imageMessage: { url: imageUrl(media), mimetype: 'image/jpeg', caption, ...dims } }
}

const shareContent = (media, kind) => {
  if (!media) return null
  const code = media.code
  const path = kind === 'clip' ? 'reel' : kind === 'igtv' ? 'tv' : 'p'
  return {
    mediaShareMessage: {
      kind,
      mediaId: media.id ?? media.pk,
      pk: media.pk,
      code,
      url: code ? `https://www.instagram.com/${path}/${code}/` : null,
      caption: media.caption_text ?? media.caption?.text ?? '',
      thumbnailUrl: media.thumbnail_url ?? imageUrl(media),
      videoUrl: media.video_url ?? videoUrl(media),
      mediaType: media.media_type,
      user: media.user
        ? { id: userJid(media.user.pk ?? media.user.id), username: media.user.username, name: media.user.full_name }
        : null
    }
  }
}

const contentFromItem = (item, nested = false) => {
  switch (item.item_type) {
    case 'text':
      return { conversation: item.text ?? '' }
    case 'link': {
      const link = item.link ?? {}
      const context = link.link_context ?? {}
      return {
        extendedTextMessage: {
          text: link.text ?? item.text ?? '',
          matchedText: context.link_url,
          canonicalUrl: context.link_url,
          title: context.link_title,
          description: context.link_summary,
          thumbnailUrl: context.link_image_url
        }
      }
    }
    case 'media':
      return mediaContent(item.media)
    case 'raven_media':
    case 'visual_media': {
      const visual = item.visual_media ?? {}
      const inner = mediaContent(visual.media)
      if (!inner) return { unknownMessage: { itemType: item.item_type, expired: true } }
      return visual.view_mode === 'once' || visual.view_mode === 'replayable'
        ? { viewOnceMessage: { message: inner } }
        : inner
    }
    case 'voice_media': {
      const media = item.media ?? item.voice_media?.media ?? {}
      const audio = media.audio ?? {}
      return {
        audioMessage: {
          url: media.audio_url ?? audio.audio_src ?? null,
          mimetype: 'audio/mp4',
          seconds: Math.round((audio.duration ?? 0) / 1000),
          ptt: true,
          waveform: audio.waveform_data
        }
      }
    }
    case 'animated_media': {
      const images = item.animated_media?.images ?? {}
      return {
        stickerMessage: {
          url: images.fixed_height?.url ?? images.original?.url ?? null,
          mimetype: 'image/gif',
          isAnimated: true,
          id: item.animated_media?.id
        }
      }
    }
    case 'media_share':
      return shareContent(item.media_share, 'post')
    case 'clip':
      return shareContent(item.clip, 'clip')
    case 'felix_share':
      return shareContent(item.felix_share?.video, 'igtv')
    case 'reel_share': {
      const share = item.reel_share ?? {}
      return {
        reelShareMessage: {
          text: share.text ?? '',
          type: share.type,
          ownerId: share.reel_owner_id ? userJid(share.reel_owner_id) : undefined,
          media: share.media ? mediaContent(share.media) : null
        }
      }
    }
    case 'story_share': {
      const share = item.story_share ?? {}
      return {
        storyShareMessage: {
          text: share.text ?? share.message ?? '',
          title: share.title,
          media: share.media ? mediaContent(share.media) : null
        }
      }
    }
    case 'profile': {
      const profile = item.profile ?? {}
      return {
        profileMessage: {
          id: userJid(profile.pk ?? profile.id ?? profile.user_id ?? ''),
          username: profile.username,
          name: profile.full_name,
          pictureUrl: profile.profile_pic_url
        }
      }
    }
    case 'location':
    case 'venue': {
      const place = item.location ?? item.venue ?? {}
      return {
        locationMessage: {
          degreesLatitude: place.lat,
          degreesLongitude: place.lng,
          name: place.name,
          address: place.address
        }
      }
    }
    case 'like':
      return { reactionMessage: { text: '\u2764\ufe0f' } }
    case 'placeholder':
      return { placeholderMessage: { text: item.placeholder?.message ?? item.placeholder?.title ?? '' } }
    case 'xma_media_share':
    case 'xma_reel_share':
    case 'xma_clip':
    case 'generic_xma':
    case 'xma_story_share':
      return { xmaMessage: { itemType: item.item_type, xma: item.xma_share ?? item.generic_xma ?? item.raw_xma ?? null } }
    default:
      return nested ? null : { unknownMessage: { itemType: item.item_type } }
  }
}

const quotedFrom = (reply, ctx) => {
  if (!reply) return null
  const id = reply.item_id ?? reply.id
  if (!id) return null
  return {
    stanzaId: String(id),
    participant: reply.user_id ? userJid(reply.user_id) : undefined,
    fromMe: String(reply.user_id) === String(ctx.selfPk),
    quotedMessage: contentFromItem(reply, true) ?? undefined
  }
}

export const convertItem = (item, ctx) => {
  const senderPk = String(item.user_id ?? '')
  const fromMe = item.is_sent_by_viewer ?? senderPk === String(ctx.selfPk)
  const sender = ctx.users?.get(senderPk)
  const timestamp = toSeconds(item.timestamp)
  const base = {
    key: {
      remoteJid: ctx.chatJid,
      fromMe: Boolean(fromMe),
      id: String(item.id ?? item.item_id),
      threadId: ctx.threadId
    },
    messageTimestamp: timestamp,
    pushName: fromMe ? ctx.selfName : sender?.full_name || sender?.username || undefined,
    clientContext: item.client_context
  }
  if (ctx.isGroup && senderPk) {
    base.key.participant = userJid(senderPk)
    base.participant = base.key.participant
  }
  if (fromMe) base.status = 'SERVER_ACK'

  if (item.item_type === 'action_log') {
    base.messageStubType = 'ACTION_LOG'
    base.messageStubParameters = [item.action_log?.description ?? '']
  } else {
    let content = contentFromItem(item)
    const quoted = quotedFrom(item.replied_to_message ?? item.reply, ctx)
    if (content && quoted) {
      if (content.conversation !== undefined) {
        content = { extendedTextMessage: { text: content.conversation, contextInfo: quoted } }
      } else {
        const type = getContentType(content)
        content = { [type]: { ...content[type], contextInfo: quoted } }
      }
    }
    base.message = content ?? undefined
  }

  const emojis = item.reactions?.emojis ?? []
  if (emojis.length) {
    base.reactions = emojis.map((reaction) => ({
      key: {
        remoteJid: ctx.chatJid,
        fromMe: String(reaction.sender_id) === String(ctx.selfPk),
        id: base.key.id,
        participant: userJid(reaction.sender_id)
      },
      text: reaction.emoji,
      senderTimestampMs: toSeconds(reaction.timestamp) * 1000
    }))
  }

  Object.defineProperty(base, 'igItem', { value: item, enumerable: false, writable: true })
  return base
}

const SENT_CONTENT = {
  image: () => ({ imageMessage: { mimetype: 'image/jpeg' } }),
  video: () => ({ videoMessage: { mimetype: 'video/mp4' } }),
  audio: () => ({ audioMessage: { mimetype: 'audio/mp4', ptt: true } })
}

export const buildSentMessage = ({ content, sent, ctx, replyTo }) => {
  const id = String(sent?.id ?? sent?.item_id ?? generateMessageID())
  let message
  if (typeof content.text === 'string') {
    message = { conversation: content.text }
    if (replyTo) {
      message = {
        extendedTextMessage: {
          text: content.text,
          contextInfo: {
            stanzaId: replyTo.key.id,
            participant: replyTo.key.participant ?? (replyTo.key.fromMe ? ctx.selfJid : replyTo.key.remoteJid),
            quotedMessage: replyTo.message
          }
        }
      }
    }
  } else {
    const kind = ['image', 'video', 'audio'].find((name) => content[name] !== undefined)
    if (kind) message = SENT_CONTENT[kind]()
    else if (content.mediaShare) message = { mediaShareMessage: { mediaId: content.mediaShare.mediaId } }
    else if (content.storyShare) message = { storyShareMessage: { storyId: content.storyShare.storyId } }
    else if (content.profile) message = { profileMessage: { id: content.profile.jid } }
  }
  return {
    key: { remoteJid: ctx.chatJid, fromMe: true, id, threadId: ctx.threadId },
    message,
    messageTimestamp: toSeconds(sent?.timestamp),
    pushName: ctx.selfName,
    status: 'SERVER_ACK',
    clientContext: sent?.client_context
  }
}
