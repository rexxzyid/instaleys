export const exploreMixin = {
  async explorePage() {
    return this.privateRequest('discover/topical_explore/')
  },

  async reportExploreMedia(mediaPk) {
    const result = await this.privateRequest('discover/explore_report/', null, { params: { m_pk: mediaPk } })
    return result.explore_report_status === 'OK'
  },

  async explorePageMediaInfo(mediaPk) {
    const result = await this.privateRequest('/v1/discover/media_metadata/', null, {
      params: { media_id: mediaPk }
    })
    return result.media_or_ad
  }
}
