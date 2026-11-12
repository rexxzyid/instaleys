import { LocationNotFound, ValidationError, WrongCursorError } from '../errors.js'
import { extractGuideV1, extractLocation, extractMediaV1 } from '../extractors.js'

const TAB_KEYS = ['ranked', 'recent']

const requireTab = (tabKey) => {
  if (!TAB_KEYS.includes(tabKey)) {
    throw new ValidationError(`You must specify one of the options for "tab_key" ${JSON.stringify(TAB_KEYS)}`)
  }
}

const decodeCursor = (maxId) => {
  const decoded = Buffer.from(String(maxId), 'base64').toString('utf8')
  try {
    const [mediaId, pageId, nextMediaIds] = JSON.parse(decoded)
    return [mediaId, pageId, nextMediaIds]
  } catch {
    throw new WrongCursorError('You specified a non-existent cursor')
  }
}

const encodeCursor = (maxId, nextPage, nextMediaIds) =>
  Buffer.from(JSON.stringify([maxId, nextPage, nextMediaIds])).toString('base64')

export const locationMixin = {
  async locationSearch(lat, lng) {
    const result = await this.privateRequest('location_search/', null, {
      params: { latitude: lat, longitude: lng }
    })
    return (result.venues ?? []).map((venue) =>
      extractLocation({ lat, lng, ...venue })
    )
  },

  async locationInfoV1(locationPk) {
    const result = await this.privateRequest(`locations/${locationPk}/location_info/`)
    if (!result.name) {
      throw new LocationNotFound('', { location_pk: String(locationPk), ...result })
    }
    const facebookId = result.facebook_places_id
    const inferFacebookSource =
      !result.external_id &&
      (typeof facebookId === 'string' || typeof facebookId === 'number') &&
      !('external_id_source' in result) &&
      !('external_source' in result)
    const location = extractLocation(result)
    if (inferFacebookSource && location.external_id !== null && location.external_id > 0) {
      location.external_id_source = 'facebook_places'
    }
    return location
  },

  async locationInfo(locationPk) {
    return this.locationInfoV1(locationPk)
  },

  async locationMediasV1Chunk(locationPk, maxAmount = 63, tabKey = 'ranked', maxId = null) {
    requireTab(tabKey)
    const data = {
      _uuid: this.uuid,
      session_id: this.clientSessionId,
      tab: tabKey
    }
    if (maxId) {
      const [mediaId, pageId, nextMediaIds] = decodeCursor(maxId)
      data.max_id = mediaId
      data.page = pageId
      data.next_media_ids = nextMediaIds
    }
    const result = await this.privateRequest(`locations/${locationPk}/sections/`, data)
    let nextMaxId = null
    if (result.next_page && result.next_max_id) {
      nextMaxId = encodeCursor(result.next_max_id, result.next_page, result.next_media_ids)
    }
    const medias = []
    for (const section of result.sections ?? []) {
      const nodes = section.layout_content?.medias ?? []
      for (const node of nodes) medias.push(extractMediaV1(node.media))
    }
    return [medias, nextMaxId]
  },

  async locationMediasV1(locationPk, amount = 63, tabKey = 'ranked') {
    requireTab(tabKey)
    const limit = Number(amount)
    const medias = []
    let maxId = null
    while (true) {
      const [items, next] = await this.locationMediasV1Chunk(locationPk, limit, tabKey, maxId)
      medias.push(...items)
      if (limit && medias.length >= limit) break
      if (!next) break
      maxId = next
    }
    return limit ? medias.slice(0, limit) : medias
  },

  async locationMediasTopV1(locationPk, amount = 21) {
    return this.locationMediasV1(locationPk, amount, 'ranked')
  },

  async locationMediasTop(locationPk, amount = 27) {
    return this.locationMediasTopV1(locationPk, amount)
  },

  async locationMediasRecentV1(locationPk, amount = 63) {
    return this.locationMediasV1(locationPk, amount, 'recent')
  },

  async locationMediasRecent(locationPk, amount = 63) {
    return this.locationMediasRecentV1(locationPk, amount)
  },

  async locationGuidesV1(locationPk) {
    const result = await this.privateRequest(`guides/location/${Number(locationPk)}/`)
    return (result.guides ?? []).map(extractGuideV1)
  }
}