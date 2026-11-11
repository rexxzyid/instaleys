import { ValidationError, WrongCursorError } from '../errors.js'
import { extractHashtagV1, extractMediaV1 } from '../extractors.js'

const normalizeHashtagName = (name) => {
  let normalized = String(name).trim()
  if (normalized.startsWith('#')) normalized = normalized.replace(/^#+/, '').trim()
  if (!normalized) throw new ValidationError('Hashtag name cannot be empty')
  return normalized
}

const sectionMediaNodes = (section) => {
  const layout = section.layout_content ?? {}
  const nodes = []
  const clips = layout.one_by_two_item?.clips
  if (clips && typeof clips === 'object') nodes.push(...(clips.items ?? []))
  for (const key of ['fill_items', 'medias']) nodes.push(...(layout[key] ?? []))
  return nodes
}

export const hashtagMixin = {
  async hashtagInfoV1(name) {
    const tag = normalizeHashtagName(name)
    return extractHashtagV1(await this.privateRequest(`tags/${tag}/info/`))
  },

  async hashtagInfo(name) {
    return this.hashtagInfoV1(name)
  },

  async hashtagMediasV1Chunk(name, maxAmount = 27, tabKey = 'top', maxId = null) {
    const tag = normalizeHashtagName(name)
    if (!['top', 'recent', 'clips'].includes(tabKey)) {
      throw new ValidationError('You must specify one of the options for "tabKey" ("top", "recent", "clips")')
    }
    const recency = { top: 'default', recent: 'top_recent_posts' }
    const data = {
      tab: tabKey,
      media_recency_filter: recency[tabKey] ?? tabKey,
      _uuid: this.uuid,
      include_persistent: 'false',
      rank_token: this.rankToken
    }
    if (maxId) {
      let decoded
      try {
        decoded = JSON.parse(Buffer.from(maxId, 'base64').toString('utf8'))
      } catch {
        throw new WrongCursorError()
      }
      const [pageId, nextMediaIds] = decoded
      data.max_id = pageId
      data.next_media_ids = JSON.stringify(nextMediaIds)
    }
    const result = await this.privateRequest(`tags/${tag}/sections/`, data, { withSignature: false })
    let nextMaxId = null
    if (result.next_max_id) {
      nextMaxId = Buffer.from(JSON.stringify([result.next_max_id, result.next_media_ids])).toString('base64')
    }
    const medias = []
    for (const section of result.sections) {
      for (const node of sectionMediaNodes(section)) {
        if (maxAmount && medias.length >= maxAmount) break
        try {
          medias.push(extractMediaV1(node.media))
        } catch (error) {
          this.logger.warn(`Skipping malformed hashtag node: ${error.message}`)
        }
      }
    }
    if (!result.more_available) nextMaxId = null
    return [medias, nextMaxId]
  },

  async hashtagMediasV1(name, amount = 27, tabKey = 'top') {
    const tag = normalizeHashtagName(name)
    const medias = []
    let maxId = null
    while (true) {
      const [items, next] = await this.hashtagMediasV1Chunk(tag, amount, tabKey, maxId)
      medias.push(...items)
      maxId = next
      if (amount && medias.length >= amount) break
      if (!maxId) break
    }
    return amount ? medias.slice(0, amount) : medias
  },

  async hashtagMediasTopV1(name, amount = 9) {
    return this.hashtagMediasV1(name, amount, 'top')
  },

  async hashtagMediasTop(name, amount = 9) {
    return this.hashtagMediasTopV1(name, amount)
  },

  async hashtagMediasRecentV1(name, amount = 27) {
    return this.hashtagMediasV1(name, amount, 'recent')
  },

  async hashtagMediasRecent(name, amount = 27) {
    return this.hashtagMediasRecentV1(name, amount)
  },

  async hashtagFollow(hashtag, unfollow = false) {
    if (!this.userId) throw new ValidationError('Login required')
    const action = unfollow ? 'unfollow' : 'follow'
    const data = this.withActionData({ user_id: this.userId })
    const result = await this.privateRequest(`web/tags/${action}/${hashtag}/`, data, {
      domain: 'www.instagram.com'
    })
    return result.status === 'ok'
  },

  async hashtagUnfollow(hashtag) {
    return this.hashtagFollow(hashtag, true)
  }
}
