import { ClientError } from '../errors.js'
import { extractHashtagV1, extractLocation, extractMediaV1, extractTrack, extractUserShort } from '../extractors.js'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const mediaOf = (item) => (isObject(item) && isObject(item.media) ? item.media : null)

const oneByTwoMedias = (layoutContent) => {
  const oneByTwo = layoutContent.one_by_two_item || {}
  if (!isObject(oneByTwo)) return []
  const medias = []
  if (isObject(oneByTwo.media)) medias.push(oneByTwo.media)
  const clips = oneByTwo.clips || {}
  if (isObject(clips)) medias.push(...(clips.items || []).map(mediaOf).filter(Boolean))
  return medias
}

const mediaGridNodes = (mediaGrid) => {
  const nodes = []
  for (const section of mediaGrid.sections || []) {
    const layoutContent = section.layout_content || {}
    nodes.push(...oneByTwoMedias(layoutContent))
    for (const key of ['fill_items', 'medias']) {
      nodes.push(...(layoutContent[key] || []).map(mediaOf).filter(Boolean))
    }
  }
  return nodes
}

const typeaheadParams = (query, timezoneOffset, count) => {
  const params = { search_surface: 'typeahead_search_page', query, context: 'blended' }
  if (timezoneOffset) params.timezone_offset = timezoneOffset
  if (count) params.count = count
  return params
}

const assignIfPresent = (params, entries) => {
  for (const [key, value] of Object.entries(entries)) {
    if (value) params[key] = value
  }
  return params
}

const recentEntries = (item) => {
  const clientTime = item.client_time ?? null
  const entries = []
  if ('user' in item) entries.push([clientTime, extractUserShort(item.user)])
  if ('hashtag' in item) {
    const { formatted_media_count: mediaCount, ...hashtag } = item.hashtag
    entries.push([clientTime, { ...hashtag, media_count: mediaCount }])
  }
  if ('keyword' in item) entries.push([clientTime, item.keyword])
  return entries
}

const appendSearchMedias = (logger, mediaGrid, medias, amount) => {
  for (const node of mediaGridNodes(mediaGrid)) {
    if (amount && medias.length >= amount) return
    try {
      medias.push(extractMediaV1(node))
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
      logger.warn(`Skipping malformed fbsearch media node: ${error.message}`)
    }
  }
}

export const fbsearchMixin = {
  async fbsearchPlaces(query, lat = 40.74, lng = -73.94) {
    const params = {
      search_surface: 'places_search_page',
      timezone_offset: this.timezoneOffset,
      lat,
      lng,
      count: 30,
      query
    }
    const result = await this.privateRequest('fbsearch/places/', null, { params })
    return result.items.map((item) => extractLocation(item.location))
  },

  async webSearchTopsearch(query) {
    const params = { search_surface: 'web_top_search', context: 'blended', include_reel: 'true', query }
    return this.privateRequest('web/search/topsearch/', null, { params })
  },

  async webSearchTopsearchHashtags(query) {
    const result = await this.webSearchTopsearch(query)
    return (result.hashtags ?? []).map((item) => extractHashtagV1(item.hashtag))
  },

  async fbsearchTopsearchFlat(query) {
    const params = {
      search_surface: 'top_search_page',
      context: 'blended',
      timezone_offset: this.timezoneOffset,
      count: 30,
      query
    }
    const result = await this.privateRequest('fbsearch/topsearch_flat/', null, { params })
    return result.list
  },

  async searchMusic(query) {
    const params = { query, browse_session_id: this.generateUuid() }
    const result = await this.privateRequest('music/audio_global_search/', null, { params })
    return result.items.filter((item) => item.track).map((item) => extractTrack(item.track))
  },

  async searchHashtags(query) {
    const params = {
      search_surface: 'hashtag_search_page',
      timezone_offset: this.timezoneOffset,
      count: 30,
      q: query
    }
    const result = await this.privateRequest('tags/search/', null, { params })
    return result.results.map(extractHashtagV1)
  },

  async fbsearchSuggestedProfiles(userId) {
    const params = { target_user_id: userId, include_friendship_status: 'true' }
    const result = await this.privateRequest('fbsearch/accounts_recs/', null, { params })
    return result.users.map(extractUserShort)
  },

  async fbsearchItem(
    itemId,
    searchSurface,
    query,
    {
      timezoneOffset = 0,
      count = 30,
      reelsPageIndex = null,
      hasMoreReels = null,
      reelsMaxId = null,
      nextMaxId = null,
      rankToken = null,
      pageIndex = null,
      pageToken = null,
      pagingToken = null
    } = {}
  ) {
    const params = { search_surface: searchSurface, query }
    if (timezoneOffset) params.timezone_offset = timezoneOffset
    if (count) params.count = count
    if (reelsPageIndex !== null) params.reels_page_index = reelsPageIndex
    assignIfPresent(params, { has_more_reels: hasMoreReels, reels_max_id: reelsMaxId, next_max_id: nextMaxId })
    assignIfPresent(params, { rank_token: rankToken })
    if (pageIndex !== null) params.page_index = pageIndex
    assignIfPresent(params, { page_token: pageToken, paging_token: pagingToken })
    return this.privateRequest(`fbsearch/${itemId}/`, null, { params })
  },

  async fbsearchKeywordTypeahead(query, { timezoneOffset = 0, count = 30 } = {}) {
    const params = typeaheadParams(query, timezoneOffset, count)
    return this.privateRequest('fbsearch/keyword_typeahead/', null, { params })
  },

  async fbsearchTypeaheadStream(query, { timezoneOffset = 0, count = 30 } = {}) {
    const params = typeaheadParams(query, timezoneOffset, count)
    return this.privateRequest('fbsearch/typeahead_stream/', null, { params })
  },

  async fbsearchTypehead(query) {
    const params = {
      search_surface: 'typeahead_search_page',
      timezone_offset: this.timezoneOffset,
      query,
      context: 'blended'
    }
    const result = await this.privateRequest('fbsearch/typeahead_stream/', null, { params })
    return (result.stream_rows || []).flatMap((row) => row.users ?? [])
  },

  async fbsearchRecent() {
    const result = await this.privateRequest('fbsearch/recent_searches/')
    if ((result.status ?? '') !== 'ok') throw new ClientError('Failed to retrieve recent searches')
    return (result.recent ?? []).flatMap(recentEntries)
  },

  async fbsearchAccountsV2(query, pageToken = null) {
    const params = { search_surface: 'account_serp', timezone_offset: this.timezoneOffset, query }
    assignIfPresent(params, { page_token: pageToken })
    return this.privateRequest('fbsearch/account_serp/', null, { params })
  },

  async fbsearchReelsV2(query, { reelsMaxId = null, rankToken = null } = {}) {
    const params = { search_surface: 'clips_search_page', timezone_offset: this.timezoneOffset, query }
    assignIfPresent(params, { reels_max_id: reelsMaxId, rank_token: rankToken })
    return this.privateRequest('fbsearch/reels_serp/', null, { params })
  },

  async fbsearchTopsearchV2(query, { nextMaxId = null, reelsMaxId = null, rankToken = null } = {}) {
    const params = {
      search_surface: 'top_serp',
      timezone_offset: this.timezoneOffset,
      query,
      rank_token: this.rankToken
    }
    assignIfPresent(params, { next_max_id: nextMaxId, rank_token: rankToken, reels_max_id: reelsMaxId })
    return this.privateRequest('fbsearch/top_serp/', null, { params })
  },

  async mediaSearch(query, amount = 27) {
    const medias = []
    const cursor = {}
    while (true) {
      const result = await this.fbsearchTopsearchV2(query, cursor)
      const mediaGrid = result.media_grid || {}
      appendSearchMedias(this.logger, mediaGrid, medias, amount)
      if (amount && medias.length >= amount) break
      cursor.nextMaxId = mediaGrid.next_max_id || result.next_max_id
      if (!mediaGrid.has_more || !cursor.nextMaxId) break
      cursor.reelsMaxId = mediaGrid.reels_max_id || result.reels_max_id
      cursor.rankToken = mediaGrid.rank_token || result.rank_token
    }
    return amount ? medias.slice(0, amount) : medias
  }
}
