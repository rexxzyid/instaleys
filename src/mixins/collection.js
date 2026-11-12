import { CollectionNotFound, ValidationError } from '../errors.js'
import { extractCollection, extractMediaV1 } from '../extractors.js'

const COLLECTION_TYPES = '["ALL_MEDIA_AUTO_COLLECTION","PRODUCT_AUTO_COLLECTION","MEDIA"]'

const requireLogin = (client) => {
  if (!client.userId) throw new ValidationError('Login required')
}

const collectionEndpoint = (collectionPk) => {
  const value = String(collectionPk)
  if (typeof collectionPk === 'number' || /^\d+$/.test(value)) return `feed/collection/${value}/`
  if (value.toLowerCase() === 'liked') return 'feed/liked/'
  return 'feed/saved/posts/'
}

const collectionMediaCount = (amount) => Number(amount)

export const collectionMixin = {
  async collections() {
    const items = []
    let nextMaxId = ''
    while (true) {
      let result
      try {
        result = await this.privateRequest('collections/list/', null, {
          params: { collection_types: COLLECTION_TYPES, max_id: nextMaxId }
        })
      } catch (error) {
        this.logger.error(error)
        return items
      }
      for (const item of result.items ?? []) items.push(extractCollection(item))
      if (!result.more_available) return items
      nextMaxId = result.next_max_id || result.max_id || ''
    }
  },

  async collectionPkByName(name) {
    for (const item of await this.collections()) {
      if (item.name === name) return item.id
    }
    throw new CollectionNotFound(name)
  },

  async collectionMediasByName(name, amount = 21, lastMediaPk = 0) {
    return this.collectionMedias(await this.collectionPkByName(name), amount, lastMediaPk)
  },

  async likedMedias(amount = 21, lastMediaPk = 0) {
    return this.collectionMedias('liked', amount, lastMediaPk)
  },

  async collectionMediasV1Chunk(collectionPk, maxId = '') {
    const params = { include_igtv_preview: 'false' }
    if (maxId) params.max_id = maxId
    const result = await this.privateRequest(collectionEndpoint(collectionPk), null, { params })
    const items = (result.items ?? []).map((item) => extractMediaV1(item.media ?? item))
    return [items, result.next_max_id || result.max_id || '']
  },

  async collectionMediasV1(collectionPk, amount = 21, lastMediaPk = 0) {
    const lastPk = lastMediaPk ? String(lastMediaPk) : ''
    const limit = collectionMediaCount(amount)
    const items = []
    let nextMaxId = ''
    let foundLastMediaPk = false
    while (true) {
      const [chunk, next] = await this.collectionMediasV1Chunk(collectionPk, nextMaxId)
      for (const item of chunk) {
        if (lastPk && lastPk === item.pk) {
          foundLastMediaPk = true
          break
        }
        items.push(item)
      }
      nextMaxId = next
      if ((limit && items.length >= limit) || foundLastMediaPk) break
      if (!chunk.length || !nextMaxId) break
    }
    return limit ? items.slice(0, limit) : items
  },

  async collectionMedias(collectionPk, amount = 21, lastMediaPk = 0) {
    return this.collectionMediasV1(collectionPk, amount, lastMediaPk)
  },

  async mediaSave(mediaId, collectionPk = null, revert = false) {
    requireLogin(this)
    const pk = this.mediaPk(mediaId)
    const data = { module_name: 'feed_timeline', radio_type: 'wifi-none' }
    if (collectionPk) data.added_collection_ids = `[${BigInt(collectionPk)}]`
    const name = revert ? 'unsave' : 'save'
    const result = await this.privateRequest(`media/${pk}/${name}/`, this.withActionData(data))
    return result.status === 'ok'
  },

  async mediaUnsave(mediaId, collectionPk = null) {
    return this.mediaSave(mediaId, collectionPk, true)
  }
}
