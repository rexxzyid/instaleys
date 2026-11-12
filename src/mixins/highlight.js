import { SUPPORTED_CAPABILITIES } from '../config.js'
import { HighlightNotFound, ValidationError } from '../errors.js'
import { extractHighlightV1 } from '../extractors.js'
import { dumps, randomBetween } from '../utils.js'

const capabilities = () => JSON.stringify(SUPPORTED_CAPABILITIES)

const randint = (min, max) => randomBetween(min, max - 1)

export const highlightMixin = {
  highlightPkFromUrl(url) {
    if (!String(url).includes('/highlights/')) {
      throw new ValidationError("URL must contain '/highlights/'")
    }
    const parts = new URL(String(url), 'https://www.instagram.com')
      .pathname.split('/')
      .filter((part) => /^\d+$/.test(part))
    if (!parts.length) throw new ValidationError(`Invalid highlight url="${url}"`)
    return parts[0]
  },

  async userHighlightsV1(userId, amount = 0) {
    const params = {
      supported_capabilities_new: capabilities(),
      phone_id: this.phoneId,
      battery_level: randint(25, 100),
      panavision_mode: '',
      is_charging: randint(0, 1),
      is_dark_mode: randint(0, 1),
      will_sound_on: randint(0, 1)
    }
    const result = await this.privateRequest(`highlights/${Number(userId)}/highlights_tray/`, null, { params })
    const tray = result.tray ?? []
    return (amount > 0 ? tray.slice(0, Number(amount)) : tray).map(extractHighlightV1)
  },

  async userHighlights(userId, amount = 0) {
    return this.userHighlightsV1(userId, amount)
  },

  async highlightInfoV1(highlightPk) {
    const highlightId = `highlight:${highlightPk}`
    const data = {
      exclude_media_ids: '[]',
      supported_capabilities_new: capabilities(),
      source: 'profile',
      _uid: String(this.userId),
      _uuid: this.uuid,
      user_ids: [highlightId]
    }
    const result = await this.privateRequest('feed/reels_media/', data)
    const reels = result.reels ?? {}
    if (!(highlightId in reels)) {
      throw new HighlightNotFound('', { highlight_pk: String(highlightPk), ...reels })
    }
    return extractHighlightV1(reels[highlightId])
  },

  async highlightInfo(highlightPk) {
    return this.highlightInfoV1(highlightPk)
  },

  async highlightEdit(
    highlightPk,
    { title = '', cover = null, addedMediaIds = [], removedMediaIds = [] } = {}
  ) {
    const data = {
      supported_capabilities_new: capabilities(),
      source: 'self_profile',
      _uid: String(this.userId),
      _uuid: this.uuid,
      added_media_ids: dumps(addedMediaIds),
      removed_media_ids: dumps(removedMediaIds)
    }
    if (title) data.title = title
    if (cover && Object.keys(cover).length) data.cover = dumps(cover)
    const result = await this.privateRequest(`highlights/highlight:${highlightPk}/edit_reel/`, data)
    return extractHighlightV1(result.reel)
  },

  async highlightChangeTitle(highlightPk, title) {
    return this.highlightEdit(highlightPk, { title })
  },

  async highlightAddStories(highlightPk, addedMediaIds) {
    return this.highlightEdit(highlightPk, { addedMediaIds })
  },

  async highlightRemoveStories(highlightPk, removedMediaIds) {
    return this.highlightEdit(highlightPk, { removedMediaIds })
  },

  async highlightCreate(title, storyIds, { coverStoryId = '', cropRect = [0.0, 0.21830457, 1.0, 0.78094524] } = {}) {
    const ids = storyIds.map((storyId) => String(storyId))
    const cover = coverStoryId || ids[0]
    const data = {
      supported_capabilities_new: capabilities(),
      source: 'self_profile',
      creation_id: String(Math.floor(Date.now() / 1000)),
      _uid: String(this.userId),
      _uuid: this.uuid,
      cover: dumps({
        media_id: await this.mediaId(cover),
        crop_rect: dumps(cropRect)
      }),
      title,
      media_ids: dumps(await Promise.all(ids.map((storyId) => this.mediaId(storyId))))
    }
    const result = await this.privateRequest('highlights/create_reel/', data)
    return extractHighlightV1(result.reel)
  },

  async highlightDelete(highlightPk) {
    const data = { _uid: String(this.userId), _uuid: this.uuid }
    const result = await this.privateRequest(`highlights/highlight:${highlightPk}/delete_reel/`, data)
    return result.status === 'ok'
  }
}