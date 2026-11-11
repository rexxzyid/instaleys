import { DirectThreadNotFound, ClientNotFoundError, ValidationError } from '../errors.js'
import { extractDirectMessage, extractDirectThread } from '../extractors.js'
import { dumps } from '../utils.js'

const SEND_ATTRIBUTES = ['message_button', 'inbox_search']
const SELECTED_FILTERS = ['flagged', 'unread']
const BOXES = ['primary', 'general']

const directIdList = (ids) => {
  if (ids === null || ids === undefined) return []
  if (typeof ids === 'number' || typeof ids === 'string' || typeof ids === 'bigint') return [BigInt(ids)]
  return [...ids].map((item) => BigInt(item))
}

const bigintList = (ids) => `[${ids.map((id) => id.toString()).join(',')}]`

const requireLogin = (client) => {
  if (!client.userId) throw new ValidationError('Login required')
}

export const directMixin = {
  directRequestTrackingParams() {
    return { eb_device_id: '0', igd_request_log_tracking_id: this.generateUuid() }
  },

  async directThreadsChunk({ selectedFilter = null, box = null, threadMessageLimit = null, cursor = null } = {}) {
    requireLogin(this)
    const params = {
      ...this.directRequestTrackingParams(),
      visual_message_return_type: 'unseen',
      thread_message_limit: '10',
      persistentBadging: 'true',
      limit: '20',
      is_prefetching: 'false',
      fetch_reason: 'initial_snapshot',
      include_old_mrs: 'false',
      no_pending_badge: 'true',
      push_disabled: this.boolToIgString(this.pushDisabled)
    }
    if (selectedFilter) {
      if (!SELECTED_FILTERS.includes(selectedFilter)) {
        throw new ValidationError(`selectedFilter must be one of ${SELECTED_FILTERS}`)
      }
      params.selected_filter = selectedFilter
    }
    if (box) {
      if (!BOXES.includes(box)) throw new ValidationError(`Unsupported box="${box}" ${BOXES}`)
      params.folder = box === 'general' ? '1' : '0'
    }
    if (threadMessageLimit) params.thread_message_limit = threadMessageLimit
    if (cursor) Object.assign(params, { cursor, direction: 'older', fetch_reason: 'page_scroll' })

    const result = await this.privateRequest('direct_v2/inbox/', null, { params })
    const inbox = result.inbox ?? {}
    const threads = (inbox.threads ?? []).map(extractDirectThread)
    return [threads, inbox.oldest_cursor ?? null]
  },

  async directThreads(amount = 20, { selectedFilter = null, box = null, threadMessageLimit = null } = {}) {
    let cursor = null
    const threads = []
    while (true) {
      const [chunk, next] = await this.directThreadsChunk({ selectedFilter, box, threadMessageLimit, cursor })
      threads.push(...chunk)
      cursor = next
      if (!cursor || (amount && threads.length >= amount)) break
    }
    return amount ? threads.slice(0, amount) : threads
  },

  async directThread(threadId, amount = 20) {
    requireLogin(this)
    const params = {
      visual_message_return_type: 'unseen',
      direction: 'older',
      seq_id: '40065',
      limit: '20'
    }
    let cursor = null
    const items = []
    let thread
    while (true) {
      if (cursor) params.cursor = cursor
      let result
      try {
        result = await this.privateRequest(`direct_v2/threads/${threadId}/`, null, { params })
      } catch (error) {
        if (error instanceof ClientNotFoundError) {
          throw new DirectThreadNotFound(error.message, { thread_id: threadId, ...this.lastJson })
        }
        throw error
      }
      thread = result.thread
      items.push(...thread.items)
      cursor = thread.oldest_cursor
      if (!cursor || (amount && items.length >= amount)) break
    }
    thread.items = amount ? items.slice(0, amount) : items
    return extractDirectThread(thread)
  },

  async directMessages(threadId, amount = 20) {
    requireLogin(this)
    return (await this.directThread(threadId, amount)).messages
  },

  async directSend(text, { userIds = [], threadIds = [], sendAttribute = 'message_button', replyToMessage = null } = {}) {
    requireLogin(this)
    const users = directIdList(userIds)
    const threads = directIdList(threadIds)
    if (!((users.length || threads.length) && !(users.length && threads.length))) {
      throw new ValidationError('Specify userIds or threadIds, but not both')
    }
    if (!SEND_ATTRIBUTES.includes(sendAttribute)) {
      throw new ValidationError(`Unsupported sendAttribute="${sendAttribute}" ${SEND_ATTRIBUTES}`)
    }
    let method = 'text'
    const token = this.generateMutationToken()
    const kwargs = {
      action: 'send_item',
      is_x_transport_forward: 'false',
      send_silently: 'false',
      is_shh_mode: '0',
      send_attribution: sendAttribute,
      client_context: token,
      device_id: this.androidDeviceId,
      mutation_token: token,
      _uuid: this.uuid,
      btt_dual_send: 'false',
      nav_chain:
        '1qT:feed_timeline:1,1qT:feed_timeline:2,1qT:feed_timeline:3,7Az:direct_inbox:4,7Az:direct_inbox:5,5rG:direct_thread:7',
      is_ae_dual_send: 'false',
      offline_threading_id: token
    }
    if (text.includes('http')) {
      method = 'link'
      kwargs.link_text = text
      kwargs.link_urls = dumps(text.match(/https?:\/\/[^\s]+/g) ?? [])
    } else {
      kwargs.text = text
    }
    if (threads.length) kwargs.thread_ids = bigintList(threads)
    if (users.length) kwargs.recipient_users = `[${bigintList(users)}]`
    if (replyToMessage) {
      kwargs.replied_to_action_source = 'swipe'
      kwargs.replied_to_item_id = replyToMessage.id
      kwargs.replied_to_client_context = replyToMessage.client_context
    }
    const result = await this.privateRequest(
      `direct_v2/threads/broadcast/${method}/`,
      this.withDefaultData(kwargs),
      { withSignature: false }
    )
    return extractDirectMessage(result.payload)
  },

  async directMessageSeen(threadId, messageId) {
    const token = this.generateMutationToken()
    const data = {
      thread_id: String(threadId),
      action: 'mark_seen',
      client_context: token,
      _uuid: this.uuid,
      offline_threading_id: token
    }
    const result = await this.privateRequest(
      `direct_v2/threads/${threadId}/items/${messageId}/seen/`,
      data,
      { withSignature: false }
    )
    return (result.status ?? '') === 'ok'
  },

  async directSendSeen(threadId) {
    const thread = await this.directThread(threadId)
    return this.directMessageSeen(threadId, thread.messages[0].id)
  },

  async directMessageDelete(threadId, messageId) {
    const data = this.withDefaultData({})
    delete data._uid
    delete data.device_id
    const result = await this.privateRequest(`direct_v2/threads/${threadId}/items/${messageId}/delete/`, data)
    return result.status === 'ok'
  }
}
