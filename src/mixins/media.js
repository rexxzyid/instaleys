import { ClientNotFoundError, MediaNotFound, ValidationError } from '../errors.js'
import { extractMediaV1, extractUserShort } from '../extractors.js'
import { InstagramIdCodec, randomBetween } from '../utils.js'

const requireLogin = (client) => {
  if (!client.userId) throw new ValidationError('Login required')
}

export const mediaMixin = {
  async mediaId(mediaPk) {
    const id = String(mediaPk)
    if (id.includes('_')) return id
    if (!/^\d+$/.test(id)) throw new ValidationError(`media_id must contain digits, now ${id}`)
    const user = await this.mediaUser(id)
    return `${id}_${user.pk}`
  },

  mediaPk(mediaId) {
    return String(mediaId).split('_')[0]
  },

  mediaCodeFromPk(mediaPk) {
    return InstagramIdCodec.encode(mediaPk)
  },

  mediaPkFromCode(code) {
    return String(InstagramIdCodec.decode(code.slice(0, 11)))
  },

  mediaPkFromUrl(url) {
    const parts = new URL(url).pathname.split('/').filter(Boolean)
    return this.mediaPkFromCode(parts.at(-1))
  },

  async mediaInfoV1(mediaPk) {
    let result
    try {
      result = await this.privateRequest(`media/${mediaPk}/info/`)
    } catch (error) {
      if (error instanceof ClientNotFoundError || String(error.message).includes('Media not found')) {
        throw new MediaNotFound(error.message, { media_pk: mediaPk, ...this.lastJson })
      }
      throw error
    }
    return extractMediaV1(result.items.at(-1))
  },

  async mediaInfo(mediaPk, useCache = true) {
    const pk = this.mediaPk(mediaPk)
    if (!useCache || !this.mediasCache.has(pk)) {
      this.mediasCache.set(pk, await this.mediaInfoV1(pk))
    }
    return structuredClone(this.mediasCache.get(pk))
  },

  async mediaUser(mediaPk) {
    return (await this.mediaInfoV1(mediaPk)).user
  },

  async mediaDelete(mediaId) {
    requireLogin(this)
    const id = await this.mediaId(mediaId)
    const result = await this.privateRequest(`media/${id}/delete/`, this.withDefaultData({ media_id: id }))
    this.mediasCache.delete(this.mediaPk(id))
    return result.did_delete
  },

  async mediaEdit(mediaId, caption, { title = '', usertags = [] } = {}) {
    requireLogin(this)
    const id = await this.mediaId(mediaId)
    const media = await this.mediaInfo(id)
    const tags = usertags.map((tag) => ({ user_id: tag.user.pk, position: [tag.x, tag.y] }))
    let data = {
      caption_text: caption,
      container_module: 'edit_media_info',
      feed_position: '0',
      location: '{}',
      usertags: JSON.stringify({ in: tags }),
      is_carousel_bumped_post: 'false'
    }
    if (media.product_type === 'igtv') {
      let igtvTitle = title
      let igtvCaption = caption
      if (!igtvTitle) {
        const index = caption.indexOf('\n')
        if (index >= 0) {
          igtvTitle = caption.slice(0, index)
          igtvCaption = caption.slice(index + 1)
        } else {
          igtvTitle = caption.slice(0, 75)
        }
      }
      data = { caption_text: igtvCaption, title: igtvTitle, igtv_ads_toggled_on: '0' }
    }
    this.mediasCache.delete(this.mediaPk(id))
    return this.privateRequest(`media/${id}/edit_media/`, this.withDefaultData(data))
  },

  async mediaLike(mediaId, revert = false) {
    requireLogin(this)
    const id = String(mediaId)
    const data = {
      inventory_source: 'media_or_ad',
      media_id: id,
      _uid: String(this.userId),
      radio_type: 'wifi-none',
      delivery_class: 'organic',
      tap_source: 'button',
      is_2m_enabled: 'false',
      is_from_swipe: 'false',
      is_carousel_bumped_post: 'false',
      floating_context_items: '[]',
      media_pct_watched: '0',
      container_module: 'feed_timeline',
      feed_position: String(randomBetween(0, 6))
    }
    const name = revert ? 'unlike' : 'like'
    const result = await this.privateRequest(`media/${id}/${name}/`, this.withActionData(data))
    return result.status === 'ok'
  },

  async mediaUnlike(mediaId) {
    return this.mediaLike(mediaId, true)
  },

  async mediaLikers(mediaId) {
    const id = await this.mediaId(mediaId)
    const result = await this.privateRequest(`media/${id}/likers/`)
    return result.users.map(extractUserShort)
  },

  async mediaSeen(mediaIds, skippedMediaIds = []) {
    const gen = async (ids) => {
      const out = {}
      for (const mediaId of ids) {
        const [pk, userId] = (await this.mediaId(mediaId)).split('_')
        const end = Math.floor(Date.now() / 1000)
        const begin = end - randomBetween(100, 3000)
        out[`${pk}_${userId}_${userId}`] = [`${begin}_${end}`]
      }
      return out
    }
    const data = {
      container_module: 'feed_timeline',
      live_vods_skipped: {},
      nuxes_skipped: {},
      nuxes: {},
      reels: await gen(mediaIds),
      live_vods: {},
      reel_media_skipped: await gen(skippedMediaIds)
    }
    const result = await this.privateRequest('/v2/media/seen/?reel=1&live_vod=0', this.withDefaultData(data))
    return result.status === 'ok'
  },

  async userMediasPaginatedV1(userId, amount = 33, endCursor = '') {
    const count = Number(amount)
    const items = (
      await this.privateRequest(`feed/user/${Number(userId)}/`, null, {
        params: {
          max_id: endCursor,
          count,
          min_timestamp: null,
          rank_token: this.rankToken,
          ranked_content: 'true'
        }
      })
    ).items
    const nextMaxId = this.lastJson.next_max_id ?? ''
    const medias = (count ? items.slice(0, count) : items).map(extractMediaV1)
    return [medias, nextMaxId]
  },

  async userMediasChunkV1(userId, endCursor = '') {
    return this.userMediasPaginatedV1(userId, 33, endCursor)
  },

  async userMediasV1(userId, amount = 0) {
    const count = Number(amount)
    const medias = []
    let cursor = ''
    while (true) {
      const [page, next] = await this.userMediasPaginatedV1(userId, count, cursor)
      medias.push(...page)
      cursor = next
      if (!cursor) break
      if (count && medias.length >= count) break
    }
    return count ? medias.slice(0, count) : medias
  },

  async *iterUserMedias(userId, { amount = 0, pageSize = 0 } = {}) {
    let cursor = ''
    let yielded = 0
    while (true) {
      const remaining = amount ? amount - yielded : 0
      if (amount && remaining <= 0) return
      const size = pageSize ? (amount ? Math.min(pageSize, remaining) : pageSize) : remaining || 33
      const [medias, next] = await this.userMediasPaginatedV1(userId, size, cursor)
      for (const media of medias) {
        yield media
        yielded += 1
        if (amount && yielded >= amount) return
      }
      if (!next || next === cursor) return
      cursor = next
    }
  },

  async userMedias(userId, amount = 0) {
    return this.userMediasV1(userId, amount)
  },

  async userClipsPaginatedV1(userId, amount = 50, endCursor = '') {
    const count = Number(amount)
    const data = {
      target_user_id: Number(userId),
      max_id: endCursor,
      page_size: count,
      include_feed_video: 'true'
    }
    const result = await this.privateRequest('clips/user/', data)
    const items = result.items ?? []
    const nextMaxId = this.lastJson.paging_info?.max_id ?? ''
    const sliced = count ? items.slice(0, count) : items
    return [sliced.map((item) => extractMediaV1(item.media)), nextMaxId]
  },

  async userClipsV1(userId, amount = 0) {
    const medias = []
    let cursor = ''
    while (true) {
      const [page, next] = await this.userClipsPaginatedV1(userId, amount || 50, cursor)
      medias.push(...page)
      cursor = next
      if (!cursor) break
      if (amount && medias.length >= amount) break
    }
    return amount ? medias.slice(0, amount) : medias
  },

  async userClips(userId, amount = 0) {
    return this.userClipsV1(userId, amount)
  },

  async mediaOembed(url) {
    return this.privateRequest(`oembed?url=${url}`)
  }
}
