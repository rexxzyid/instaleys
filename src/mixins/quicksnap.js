import { ClientGraphqlError, ValidationError } from '../errors.js'

const QUICKSNAP_HISTORY_CLIENT_DOC_ID = '202528380816979569862257718136'
const QUICKSNAP_HISTORY_FRIENDLY_NAME = 'IGQuickSnapGetHistoryPaginatedQuery'
const QUICKSNAP_HISTORY_KEY = 'quick_snap_paginated_history'

const requireLogin = (client) => {
  if (!client.userId) throw new ValidationError('Login required')
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export const quickSnapHistoryFromGraphqlResult = (result) => {
  const viewer = (result.data || {}).viewer || {}
  for (const [key, value] of Object.entries(viewer)) {
    if (key.includes(QUICKSNAP_HISTORY_KEY) && isPlainObject(value)) return value
  }
  throw new ClientGraphqlError('Failed to retrieve QuickSnap history')
}

export const quicksnapMixin = {
  async quicksnapHistory(amount = 20, endCursor = null) {
    requireLogin(this)
    const variables = { first: amount }
    if (endCursor) variables.after = endCursor
    const result = await this.privateGraphqlWwwRequest({
      friendlyName: QUICKSNAP_HISTORY_FRIENDLY_NAME,
      variables,
      clientDocId: QUICKSNAP_HISTORY_CLIENT_DOC_ID
    })
    return quickSnapHistoryFromGraphqlResult(result)
  },

  async quicksnapDelete(mediaId) {
    requireLogin(this)
    const id = String(mediaId)
    const result = await this.privateRequest(`media/${id}/soft_delete/`, { media_id: id, _uuid: this.uuid })
    return result.did_delete === true
  }
}
