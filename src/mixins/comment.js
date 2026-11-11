import { ClientNotFoundError, MediaNotFound, ValidationError } from '../errors.js'
import { extractComment } from '../extractors.js'
import { randomBetween } from '../utils.js'

export const commentMixin = {
  async mediaCommentsV1Chunk(mediaId, minId = '', maxId = '') {
    const params = { can_support_threading: 'true', permalink_enabled: 'false' }
    if (minId) params.min_id = minId
    if (maxId) params.max_id = maxId
    const result = await this.privateRequest(`media/${mediaId}/comments/`, null, { params })
    const comments = (result.comments ?? []).map(extractComment)
    return [comments, result.next_min_id || result.min_id || '', result.next_max_id || result.max_id || '']
  },

  async mediaCommentsV1(mediaId, amount = 20) {
    const comments = []
    let minId = null
    let maxId = null
    try {
      while (true) {
        const [items, nextMin, nextMax] = await this.mediaCommentsV1Chunk(mediaId, minId, maxId)
        minId = nextMin
        maxId = nextMax
        comments.push(...items)
        if (items.length === 0) break
        if (amount && comments.length > amount) break
        if (!minId && !maxId) break
      }
    } catch (error) {
      if (error instanceof ClientNotFoundError || String(error.message).includes('Media not found')) {
        throw new MediaNotFound(error.message, { media_id: mediaId, ...this.lastJson })
      }
      throw error
    }
    return amount ? comments.slice(0, amount) : comments
  },

  async mediaComments(mediaId, amount = 20) {
    return this.mediaCommentsV1(mediaId, amount)
  },

  async mediaCommentRepliesChunk(mediaId, commentId, maxAmount = 0, minId = null) {
    const id = await this.mediaId(mediaId)
    const data = minId ? { min_id: minId } : null
    let result
    try {
      result = await this.privateRequest(`media/${id}/comments/${String(commentId)}/inline_child_comments/`, data)
    } catch (error) {
      if (error instanceof ClientNotFoundError || String(error.message).includes('Media not found')) {
        throw new MediaNotFound(error.message, { media_id: id, ...this.lastJson })
      }
      throw error
    }
    const replies = (result.child_comments ?? []).map(extractComment)
    return [maxAmount ? replies.slice(0, maxAmount) : replies, result.next_min_child_cursor ?? null]
  },

  async mediaCommentReplies(mediaId, commentId, amount = 0) {
    const id = await this.mediaId(mediaId)
    const replies = []
    let data = null
    while (true) {
      let result
      try {
        result = await this.privateRequest(`media/${id}/comments/${String(commentId)}/inline_child_comments/`, data)
      } catch (error) {
        if (error instanceof ClientNotFoundError || String(error.message).includes('Media not found')) {
          throw new MediaNotFound(error.message, { media_id: id, ...this.lastJson })
        }
        throw error
      }
      replies.push(...(result.child_comments ?? []).map(extractComment))
      if (amount && replies.length >= amount) break
      if (!(result.has_more_head_child_comments && result.next_min_child_cursor)) break
      data = { min_id: result.next_min_child_cursor }
    }
    return amount ? replies.slice(0, amount) : replies
  },

  async mediaComment(mediaId, text, repliedToCommentId = null) {
    if (!this.userId) throw new ValidationError('Login required')
    const id = await this.mediaId(mediaId)
    const idempotenceToken = this.generateUuid()
    const data = {
      delivery_class: 'organic',
      feed_position: String(randomBetween(0, 6)),
      container_module: 'feed_timeline',
      media_id: id,
      _uid: String(this.userId),
      tap_source: 'button',
      is_2m_enabled: 'false',
      is_carousel_bumped_post: 'false',
      is_from_swipe: 'false',
      floating_context_items: '[]',
      media_pct_watched: '0',
      user_breadcrumb: this.genUserBreadcrumb(text.length),
      idempotence_token: idempotenceToken,
      comment_creation_key: idempotenceToken,
      include_e2ee_mentioned_user_list: 'true',
      include_media_code: 'true',
      comment_text: text
    }
    if (repliedToCommentId) data.replied_to_comment_id = Number(repliedToCommentId)
    const result = await this.privateRequest(`media/${id}/comment/`, this.withActionData(data))
    return extractComment(result.comment)
  },

  async mediaCheckOffensiveComment(mediaId, text) {
    if (!this.userId) throw new ValidationError('Login required')
    const id = await this.mediaId(mediaId)
    const result = await this.privateRequest(
      'media/comment/check_offensive_comment/',
      this.withActionData({ media_id: id, comment_text: text })
    )
    return result.is_offensive
  },

  async commentLike(commentPk, revert = false) {
    if (!this.userId) throw new ValidationError('Login required')
    const pk = Number(commentPk)
    const data = {
      is_carousel_bumped_post: 'false',
      container_module: 'feed_contextual_self_profile',
      feed_position: String(randomBetween(0, 6))
    }
    const name = revert ? 'unlike' : 'like'
    const result = await this.privateRequest(`media/${pk}/comment_${name}/`, this.withActionData(data))
    return result.status === 'ok'
  },

  async commentUnlike(commentPk) {
    return this.commentLike(commentPk, true)
  },

  async commentBulkDelete(mediaId, commentPks) {
    const id = await this.mediaId(mediaId)
    const data = {
      comment_ids_to_delete: commentPks.map(String).join(','),
      container_module: 'self_comments_v2_newsfeed_you'
    }
    const result = await this.privateRequest(`media/${id}/comment/bulk_delete/`, this.withActionData(data))
    return result.status === 'ok'
  }
}
