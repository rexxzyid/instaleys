import { ClientError, TrackNotFound } from '../errors.js'
import { extractTrack } from '../extractors.js'
import { jsonValue } from '../utils.js'

const TRACK_ERROR_KEYS = ['music_canonical_id', 'original_sound_audio_asset_id']

const isEmptyJson = (value) => !value || (typeof value === 'object' && Object.keys(value).length === 0)

const pickTrackErrorKeys = (data) =>
  Object.fromEntries(Object.entries(data).filter(([key]) => TRACK_ERROR_KEYS.includes(key)))

const trackRequest = async (client, data, path = 'clips/music/') => {
  try {
    return await client.privateRequest(path, data)
  } catch (error) {
    if (error instanceof ClientError && isEmptyJson(client.lastJson)) {
      throw new TrackNotFound('', pickTrackErrorKeys(data))
    }
    throw error
  }
}

export const trackMixin = {
  async musicInFeedAudioBrowser(browseSessionId = null) {
    return this.privateRequest(
      'music/music_in_feed_audio_browser/',
      {
        product: 'music_in_feed',
        _uuid: this.uuid,
        browse_session_id: browseSessionId ?? this.generateUuid()
      },
      { withSignature: false }
    )
  },

  async musicTrending(product = 'feed_post') {
    return this.privateRequest(
      'music/trending/',
      { product, _uuid: this.uuid },
      { withSignature: false }
    )
  },

  async musicTopTrends(product = 'music_in_feed', pageSize = 15) {
    return this.privateRequest(
      'music/top_trends/',
      { product, _uuid: this.uuid, page_size: String(pageSize) },
      { withSignature: false }
    )
  },

  async musicSearchV2(query, opts = {}) {
    const {
      product = 'music_in_feed',
      fromTypeahead = false,
      searchSessionId = null,
      browseSessionId = null
    } = opts
    return this.privateRequest(
      'music/search_v2/',
      {
        from_typeahead: this.boolToIgString(fromTypeahead),
        search_session_id: searchSessionId ?? this.generateUuid(),
        product,
        q: String(query),
        _uuid: this.uuid,
        browse_session_id: browseSessionId ?? this.generateUuid()
      },
      { withSignature: false }
    )
  },

  async musicKeywordSearch(query, opts = {}) {
    const {
      product = 'music_in_feed',
      numKeywords = 3,
      searchSessionId = '',
      browseSessionId = null
    } = opts
    return this.privateRequest('music/keyword_search/', null, {
      params: {
        num_keywords: String(numKeywords),
        search_session_id: searchSessionId,
        product,
        q: String(query),
        browse_session_id: browseSessionId ?? this.generateUuid()
      }
    })
  },

  async musicBookmark(originalAudioId, surfaceRequestedFrom = 'audio_aggregation_page') {
    const result = await this.privateRequest(
      'music/bookmark_music/',
      {
        original_audio_id: String(originalAudioId),
        _uuid: this.uuid,
        surface_requested_from: surfaceRequestedFrom
      },
      { withSignature: false }
    )
    return Boolean(result.success) || result.status === 'ok'
  },

  async musicBookmarked(maxId = '') {
    const data = { _uuid: this.uuid }
    if (maxId) data.max_id = maxId
    return this.privateRequest('music/playlist/bookmarked/', data, { withSignature: false })
  },

  async musicClipsAudioBrowser(product = 'story_camera_clips_v2', browseSessionId = null) {
    return this.privateRequest(
      'music/clips_audio_browser/',
      {
        product,
        _uuid: this.uuid,
        browse_session_id: browseSessionId ?? this.generateUuid()
      },
      { withSignature: false }
    )
  },

  async musicVerifyOriginalAudioTitle(originalAudioName) {
    const result = await this.privateRequest(
      'music/verify_original_audio_title/',
      { original_audio_name: originalAudioName, _uuid: this.uuid },
      { withSignature: false }
    )
    return Boolean(result.is_valid)
  },

  async trackInfoByCanonicalId(musicCanonicalId) {
    const canonicalId = String(musicCanonicalId)
    const result = await this.privateRequest('clips/music/', {
      tab_type: 'clips',
      referrer_media_id: '',
      _uuid: this.uuid,
      music_canonical_id: canonicalId
    })
    const track = jsonValue(result, ['metadata', 'music_info', 'music_asset_info'])
    if (isEmptyJson(track)) throw new TrackNotFound('', { music_canonical_id: canonicalId })
    return extractTrack(track)
  },

  async trackInfoById(trackId, maxId = '') {
    const data = { audio_cluster_id: trackId, original_sound_audio_asset_id: trackId }
    if (maxId) data.max_id = maxId
    return trackRequest(this, data)
  },

  async trackStreamInfoById(trackId, maxId = '') {
    const musicPage = { tab_type: 'clips', audio_asset_id: trackId, audio_cluster_id: trackId }
    if (maxId) musicPage.max_id = maxId
    return trackRequest(
      this,
      { pivot_page_type: 'audio', music_page: musicPage, _uuid: this.uuid },
      'clips/stream_clips_pivot_page/'
    )
  }
}
