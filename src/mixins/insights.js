import { ClientError, MediaError, UserError, ValidationError } from '../errors.js'
import { sleep } from '../utils.js'

const POST_TYPES = ['ALL', 'CAROUSEL_V2', 'IMAGE', 'SHOPPING', 'VIDEO']
const TIME_FRAMES = ['ONE_WEEK', 'ONE_MONTH', 'THREE_MONTHS', 'SIX_MONTHS', 'ONE_YEAR', 'TWO_YEARS']
const DATA_ORDERS = [
  'REACH_COUNT',
  'LIKE_COUNT',
  'FOLLOW',
  'SHARE_COUNT',
  'BIO_LINK_CLICK',
  'COMMENT_COUNT',
  'IMPRESSION_COUNT',
  'PROFILE_VIEW',
  'VIDEO_VIEW_COUNT',
  'SAVE_COUNT'
]
const EMPTY_GRAPHQL_QUERY_PARAM = ''

const requireOneOf = (value, allowed, name) => {
  if (!allowed.includes(value)) {
    throw new ValidationError(`Unsupported ${name}="${value}" ${JSON.stringify(allowed)}`)
  }
}

const requireLogin = (client) => {
  if (!client.userId) throw new ValidationError('Login required')
}

const insightsData = (surface, docId) => ({
  surface,
  doc_id: docId,
  locale: 'en_US',
  vc_policy: 'insights_policy',
  strip_nulls: false,
  strip_defaults: false
})

const businessManager = (result) => result?.data?.shadow_instagram_user?.business_manager ?? null

export const insightsMixin = {
  async insightsMediaFeedAll({
    postType = 'ALL',
    timeFrame = 'TWO_YEARS',
    dataOrdering = 'REACH_COUNT',
    count = 0,
    sleepSeconds = 2
  } = {}) {
    requireOneOf(postType, POST_TYPES, 'post_type')
    requireOneOf(timeFrame, TIME_FRAMES, 'time_frame')
    requireOneOf(dataOrdering, DATA_ORDERS, 'data_ordering')
    requireLogin(this)
    const medias = []
    const data = insightsData('post_grid', 2345520318892697)
    const queryParams = {
      IgInsightsGridMediaImage_SIZE: 480,
      count: 200,
      dataOrdering,
      postType,
      timeframe: timeFrame,
      search_base: 'USER',
      is_user: 'true',
      queryParams: { access_token: EMPTY_GRAPHQL_QUERY_PARAM, id: this.userId }
    }
    let cursor = null
    while (true) {
      if (cursor) queryParams.cursor = cursor
      const result = await this.privateRequest('ads/graphql/', this.withQueryParams(data, queryParams))
      const manager = businessManager(result)
      if (!manager) throw new UserError('Account is not business account', { ...this.lastJson })
      const stats = manager.top_posts_unit.top_posts
      cursor = stats.page_info.end_cursor
      medias.push(...stats.edges)
      if (!stats.page_info.has_next_page) break
      if (count && medias.length >= count) break
      await sleep(sleepSeconds * 1000)
    }
    return count ? medias.slice(0, count) : medias
  },

  async insightsAccount() {
    requireLogin(this)
    const data = insightsData('account', 2449243051851783)
    const queryParams = {
      IgInsightsGridMediaImage_SIZE: 360,
      activityTab: true,
      audienceTab: true,
      contentTab: true,
      query_params: { access_token: EMPTY_GRAPHQL_QUERY_PARAM, id: this.userId }
    }
    const result = await this.privateRequest('ads/graphql/', this.withQueryParams(data, queryParams))
    const manager = businessManager(result)
    if (!manager) throw new UserError('Account is not business account', { ...this.lastJson })
    return manager
  },

  async insightsMedia(mediaPk) {
    requireLogin(this)
    const pk = this.mediaPk(mediaPk)
    const data = insightsData('post', 3221905377882880)
    const queryParams = { query_params: { access_token: EMPTY_GRAPHQL_QUERY_PARAM, id: pk } }
    try {
      const result = await this.privateRequest('ads/graphql/', this.withQueryParams(data, queryParams))
      const media = result?.data?.instagram_post_by_igid ?? null
      if (!media) {
        throw new MediaError('Instagram did not return insight data for media', {
          ...(this.lastJson ?? {}),
          media_pk: pk
        })
      }
      if (!media.inline_insights_node) {
        throw new MediaError('Instagram returned media metadata without inline insights data', {
          ...(this.lastJson ?? {}),
          media_pk: pk
        })
      }
      return media
    } catch (error) {
      if (error instanceof MediaError) throw error
      if (error instanceof ClientError) {
        throw new MediaError(error.message, { ...(this.lastJson ?? {}), media_pk: pk })
      }
      throw error
    }
  }
}
