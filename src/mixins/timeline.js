import { extractMediaV1 } from '../extractors.js'

const REELS_ENDPOINTS = {
  reels: 'clips/connected/',
  explore_reels: 'clips/discover/',
  friends_reels: 'clips/discover/social/'
}

export const timelineMixin = {
  async reels(amount = 10, lastMediaPk = 0) {
    return this.reelsTimelineMedia('reels', amount, lastMediaPk)
  },

  async exploreReels(amount = 10, lastMediaPk = 0) {
    return this.reelsTimelineMedia('explore_reels', amount, lastMediaPk)
  },

  async friendsReels(amount = 10, lastMediaPk = 0) {
    return this.reelsTimelineMedia('friends_reels', amount, lastMediaPk)
  },

  async reelsTimelineMedia(collectionPk, amount = 10, lastMediaPk = 0) {
    const endpoint = REELS_ENDPOINTS[collectionPk]
    if (!endpoint) {
      this.logger.warn(`Unsupported reels timeline collection: ${collectionPk}`)
      return []
    }
    const limit = Number(amount)
    const lastPk = lastMediaPk ? String(lastMediaPk) : ''
    const items = []
    let nextMaxId = ''
    const seenCursors = new Set([nextMaxId])
    while (true) {
      if (items.length >= limit) return items.slice(0, limit)
      let result
      try {
        result = await this.privateRequest(endpoint, ' ', { params: { max_id: nextMaxId } })
      } catch (error) {
        this.logger.error(error)
        return items
      }
      const chunk = result.items || result.items_with_ads || []
      for (const item of chunk) {
        const media = item.media
        if (!media) continue
        if (lastPk && lastPk === String(media.pk)) return items
        items.push(extractMediaV1(media))
        if (items.length >= limit) return items.slice(0, limit)
      }
      const paging = result.paging_info ?? {}
      if (!paging.more_available) return items
      nextMaxId = paging.max_id ?? ''
      if (!nextMaxId || seenCursors.has(nextMaxId)) return items
      seenCursors.add(nextMaxId)
    }
  }
}
