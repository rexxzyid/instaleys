import { SUPPORTED_CAPABILITIES } from '../config.js'
import { StoryNotFound, ValidationError } from '../errors.js'
import { extractStoryV1, extractUserShort, extractViewer } from '../extractors.js'

const capabilitiesParams = () => ({ supported_capabilities_new: JSON.stringify(SUPPORTED_CAPABILITIES) })

export const storyMixin = {
  async userStoriesV1(userId, amount = null) {
    const reel =
      (await this.privateRequest(`feed/user/${Number(userId)}/story/`, null, { params: capabilitiesParams() })).reel ??
      {}
    const stories = (reel.items ?? []).map(extractStoryV1)
    return amount ? stories.slice(0, Number(amount)) : stories
  },

  async userStories(userId, amount = null) {
    return this.userStoriesV1(userId, amount)
  },

  async storyInfoV1(storyPk) {
    const storyId = await this.mediaId(storyPk)
    const [pk, userId] = storyId.split('_')
    const stories = await this.userStoriesV1(userId)
    for (const story of stories) this.storiesCache.set(story.pk, story)
    if (!this.storiesCache.has(pk)) throw new StoryNotFound('Story not found', { story_pk: pk, ...this.lastJson })
    return structuredClone(this.storiesCache.get(pk))
  },

  async storyInfo(storyPk, useCache = true) {
    const pk = this.mediaPk(storyPk)
    if (!useCache || !this.storiesCache.has(pk)) {
      this.storiesCache.set(pk, await this.storyInfoV1(storyPk))
    }
    return structuredClone(this.storiesCache.get(pk))
  },

  async storyDelete(storyPk) {
    if (!this.userId) throw new ValidationError('Login required')
    const mediaId = await this.mediaId(storyPk)
    this.storiesCache.delete(this.mediaPk(mediaId))
    return this.mediaDelete(mediaId)
  },

  async storySeen(storyPks, skippedStoryPks = []) {
    if (!Array.isArray(storyPks)) throw new ValidationError('storyPks should be a list of story.pk')
    const ids = await Promise.all(storyPks.map((pk) => this.mediaId(pk)))
    const skipped = await Promise.all(skippedStoryPks.map((pk) => this.mediaId(pk)))
    return this.mediaSeen(ids, skipped)
  },

  async storyViewersChunk(storyPk, maxAmount = 0, maxId = '') {
    const unique = new Set()
    const viewers = []
    const pk = this.mediaPk(storyPk)
    const params = capabilitiesParams()
    let cursor = maxId
    while (true) {
      if (cursor) params.max_id = cursor
      const result = await this.privateRequest(`media/${pk}/list_reel_media_viewer/`, null, { params })
      for (const item of result.viewers ?? []) {
        const viewer = extractViewer(item)
        if (unique.has(viewer.pk)) continue
        unique.add(viewer.pk)
        viewers.push(viewer)
      }
      cursor = result.next_max_id
      if (!cursor || (maxAmount && viewers.length >= maxAmount)) break
    }
    return [viewers, cursor]
  },

  async storyViewers(storyPk, amount = 0) {
    const [viewers] = await this.storyViewersChunk(storyPk, amount)
    return amount ? viewers.slice(0, amount) : viewers
  },

  async storyLikersChunk(storyPk, maxAmount = 0, maxId = '') {
    const unique = new Set()
    const likers = []
    const pk = this.mediaPk(storyPk)
    const params = capabilitiesParams()
    let cursor = maxId
    while (true) {
      if (cursor) params.max_id = cursor
      const result = await this.privateRequest(`media/${pk}/list_reel_media_viewer/`, null, { params })
      for (const item of result.viewers ?? []) {
        if (!item.has_liked) continue
        const liker = extractUserShort(item.user)
        if (unique.has(liker.pk)) continue
        unique.add(liker.pk)
        likers.push(liker)
      }
      cursor = result.next_max_id
      if (!cursor || (maxAmount && likers.length >= maxAmount)) break
    }
    return [likers, cursor]
  },

  async storyLikers(storyPk, amount = 0) {
    const [likers] = await this.storyLikersChunk(storyPk, amount)
    return amount ? likers.slice(0, amount) : likers
  }
}
