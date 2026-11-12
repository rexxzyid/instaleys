import { randomBytes, randomUUID } from 'node:crypto'
import {
  ClientError,
  DirectMessageNotFound,
  DirectThreadNotFound,
  ValidationError
} from '../errors.js'
import { extractDirectMessage, extractDirectThread, extractUserShort } from '../extractors.js'
import { loadBytes, prepareImage, readMp4Metadata } from '../media-utils.js'
import { dumps, randomBetween } from '../utils.js'

const SEARCH_MODES = ['raven', 'universal']
const SEND_ATTRIBUTES_MEDIA = [
  'feed_timeline',
  'feed_contextual_chain',
  'feed_short_url',
  'feed_contextual_self_profile',
  'feed_contextual_profile'
]
const NAV_CHAIN =
  '1qT:feed_timeline:1,1qT:feed_timeline:2,1qT:feed_timeline:3,7Az:direct_inbox:4,7Az:direct_inbox:5,5rG:direct_thread:7'

const idList = (ids) => {
  if (ids === null || ids === undefined) return []
  if (typeof ids === 'number' || typeof ids === 'string' || typeof ids === 'bigint') return [BigInt(ids)]
  return [...ids].map((item) => BigInt(item))
}

const bigintList = (ids) => `[${ids.map((id) => id.toString()).join(',')}]`

const requireLogin = (client) => {
  if (!client.userId) throw new ValidationError('Login required')
}

const requireTarget = (userIds, threadIds) => {
  if (!((userIds.length || threadIds.length) && !(userIds.length && threadIds.length))) {
    throw new ValidationError('Specify userIds or threadIds, but not both')
  }
}

const parseJson = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

export const directExtraMixin = {
  async directPendingChunk(cursor = null) {
    requireLogin(this)
    const params = {
      visual_message_return_type: 'unseen',
      persistentBadging: 'true',
      is_prefetching: 'false',
      request_session_id: this.requestId
    }
    if (cursor) params.cursor = cursor
    const result = await this.privateRequest('direct_v2/pending_inbox/', null, { params })
    const inbox = result.inbox ?? {}
    return [(inbox.threads ?? []).map(extractDirectThread), inbox.oldest_cursor ?? null]
  },

  async directPendingInbox(amount = 20) {
    let cursor = null
    const threads = []
    while (true) {
      const [chunk, next] = await this.directPendingChunk(cursor)
      threads.push(...chunk)
      cursor = next
      if (!cursor || (amount && threads.length >= amount)) break
    }
    return amount ? threads.slice(0, amount) : threads
  },

  async directRequests(amount = 20) {
    return this.directPendingInbox(amount)
  },

  async directPendingApprove(threadId) {
    requireLogin(this)
    const result = await this.privateRequest(
      `direct_v2/threads/${threadId}/approve/`,
      { filter: 'DEFAULT', _uuid: this.uuid },
      { withSignature: false }
    )
    return (result.status ?? '') === 'ok'
  },

  async directRequestApprove(threadId) {
    return this.directPendingApprove(threadId)
  },

  async directSpamChunk(cursor = null) {
    requireLogin(this)
    const params = {
      visual_message_return_type: 'unseen',
      persistentBadging: 'true',
      is_prefetching: 'false'
    }
    if (cursor) params.cursor = cursor
    const result = await this.privateRequest('direct_v2/spam_inbox/', null, { params })
    const inbox = result.inbox ?? {}
    return [(inbox.threads ?? []).map(extractDirectThread), inbox.oldest_cursor ?? null]
  },

  async directSpamInbox(amount = 20) {
    let cursor = null
    const threads = []
    while (true) {
      const [chunk, next] = await this.directSpamChunk(cursor)
      threads.push(...chunk)
      cursor = next
      if (!cursor || (amount && threads.length >= amount)) break
    }
    return amount ? threads.slice(0, amount) : threads
  },

  async directMessage(threadId, messageId, amount = 20) {
    const id = String(messageId)
    for (const message of await this.directMessages(threadId, amount)) {
      if (message.id === id) return message
    }
    throw new DirectMessageNotFound(`Direct message ${id} not found in thread ${threadId}`, {
      thread_id: threadId,
      message_id: id
    })
  },

  async directAnswer(threadId, text) {
    requireLogin(this)
    return this.directSend(text, { threadIds: [threadId] })
  },

  async directMessageReaction(
    threadId,
    messageId,
    emoji,
    reactionStatus,
    { clientContext = null, actionSource = 'double_tap', targetItemType = null } = {}
  ) {
    requireLogin(this)
    if (!['created', 'deleted'].includes(reactionStatus)) {
      throw new ValidationError(`Unsupported reactionStatus="${reactionStatus}"`)
    }
    const token = this.generateMutationToken()
    const data = {
      action: 'send_item',
      is_x_transport_forward: 'false',
      send_silently: 'false',
      is_shh_mode: '0',
      send_attribution: 'message_reaction',
      client_context: token,
      device_id: this.androidDeviceId,
      mutation_token: token,
      btt_dual_send: 'false',
      nav_chain: NAV_CHAIN,
      is_ae_dual_send: 'false',
      offline_threading_id: token,
      thread_ids: dumps([String(threadId)]),
      item_type: 'reaction',
      reaction_type: 'like',
      reaction_status: reactionStatus,
      node_type: 'item',
      item_id: String(messageId),
      emoji,
      reaction_action_source: actionSource
    }
    if (clientContext) data.original_message_client_context = clientContext
    if (targetItemType) data.target_item_type = targetItemType
    const result = await this.privateRequest(
      'direct_v2/threads/broadcast/reaction/',
      this.withDefaultData(data),
      { withSignature: false }
    )
    return result.status === 'ok'
  },

  async directSendReaction(threadId, messageId, emoji = '\u2764\ufe0f', opts = {}) {
    return this.directMessageReaction(threadId, messageId, emoji, 'created', opts)
  },

  async directDeleteReaction(threadId, messageId, emoji = '\u2764\ufe0f', opts = {}) {
    return this.directMessageReaction(threadId, messageId, emoji, 'deleted', opts)
  },

  async directMessageLike(threadId, messageId, clientContext = null) {
    return this.directSendReaction(threadId, messageId, undefined, { clientContext })
  },

  async directMessageUnlike(threadId, messageId, clientContext = null) {
    return this.directDeleteReaction(threadId, messageId, undefined, { clientContext })
  },

  async directMessageUnsend(threadId, messageId) {
    return this.directMessageDelete(threadId, messageId)
  },

  async directUsersPresence(userIds) {
    requireLogin(this)
    const ids = idList(userIds)
    const data = {
      _uuid: this.uuid,
      subscriptions_off: 'false',
      request_data: bigintList(ids)
    }
    const result = await this.privateRequest(
      'direct_v2/fetch_and_subscribe_presence/',
      this.withDefaultData(data),
      { withSignature: false }
    )
    if (result.status !== 'ok') throw new ClientError(`Failed to retrieve presence of user_id=${ids}`)
    return result
  },

  async directActivePresence() {
    const result = await this.privateRequest('direct_v2/get_presence_active_now/', null, {
      params: { recent_thread_limit: 0, suggested_followers_limit: 100 }
    })
    if (result.status !== 'ok') throw new ClientError('Failed to retrieve active presences')
    return result.user_presence ?? {}
  },

  async directSearch(query, mode = 'universal') {
    if (!SEARCH_MODES.includes(mode)) throw new ValidationError(`Unsupported mode="${mode}" ${SEARCH_MODES}`)
    const result = await this.privateRequest('direct_v2/ranked_recipients/', null, {
      params: {
        max_ai_bot_results: '0',
        max_ig_bus_results: '10',
        mode,
        show_threads: 'true',
        query: String(query),
        max_ig_results: '10',
        max_ibc_results: '20',
        max_fb_results: '0'
      }
    })
    return (result.ranked_recipients ?? [])
      .filter((item) => item.user && (item.user.username ?? '') !== '')
      .map((item) => extractUserShort(item.user))
  },

  async directThreadByParticipants(userIds) {
    const ids = idList(userIds)
    const result = await this.privateRequest('direct_v2/threads/get_by_participants/', null, {
      params: { recipient_users: bigintList(ids), seq_id: 2580572, limit: 20 }
    })
    result.users = (result.users ?? []).map((user) => ({
      pk: String(user.pk),
      username: user.username,
      full_name: user.full_name,
      profile_pic_url: user.profile_pic_url,
      is_private: user.is_private
    }))
    return result
  },

  async directThreadIdFromUserIds(userIds, mediaKind) {
    const ids = idList(userIds)
    let thread = await this.directThreadByParticipants(ids)
    let threadId = thread.thread_v2_id || thread.thread_id
    if (!threadId && this.lastJson && typeof this.lastJson === 'object') {
      thread = this.lastJson.thread ?? {}
      threadId = thread.thread_v2_id || thread.thread_id
    }
    if (!threadId) {
      throw new DirectThreadNotFound(
        `No existing direct thread found for participants; direct ${mediaKind} send currently requires an existing thread`,
        { user_ids: ids.map(String), ...(this.lastJson ?? {}) }
      )
    }
    return BigInt(threadId)
  },

  async directThreadHide(threadId, moveToSpam = false) {
    requireLogin(this)
    const result = await this.privateRequest(
      `direct_v2/threads/${threadId}/hide/`,
      { should_move_future_requests_to_spam: moveToSpam, _uuid: this.uuid },
      { withSignature: false }
    )
    return (result.status ?? '') === 'ok'
  },

  async directThreadUpdateTitle(threadId, title) {
    requireLogin(this)
    const result = await this.privateRequest(
      `direct_v2/threads/${threadId}/update_title/`,
      { _uuid: this.uuid, title },
      { withSignature: false }
    )
    return (result.status ?? '') === 'ok'
  },

  async directThreadAddUsers(threadId, userIds) {
    requireLogin(this)
    const ids = idList(userIds)
    if (!ids.length) throw new ValidationError('At least one userId required')
    const result = await this.privateRequest(
      `direct_v2/threads/${threadId}/add_user/`,
      { _uuid: this.uuid, user_ids: dumps(ids.map(String)) },
      { withSignature: false }
    )
    return (result.status ?? '') === 'ok'
  },

  async directThreadCreate(userIds, title = '') {
    requireLogin(this)
    const ids = idList(userIds)
    if (ids.length < 2) throw new ValidationError('Group threads require at least two recipient userIds')
    const result = await this.privateRequest('direct_v2/create_group_thread/', {
      _uuid: this.uuid,
      _uid: String(this.userId),
      client_context: this.generateMutationToken(),
      is_partnership_folder: 'false',
      recipient_users: bigintList(ids),
      thread_title: title
    })
    const threadId = result.thread_id || result.thread?.thread_id
    if (!threadId) throw new ClientError('Create group thread response missing thread_id', result)
    return String(threadId)
  },

  async directThreadMarkUnread(threadId) {
    const data = this.withDefaultData({})
    delete data._uid
    delete data.device_id
    const result = await this.privateRequest(`direct_v2/threads/${threadId}/mark_unread/`, data)
    return result.status === 'ok'
  },

  async directThreadMute(threadId, revert = false) {
    const name = revert ? 'unmute' : 'mute'
    const result = await this.privateRequest(`direct_v2/threads/${threadId}/${name}/`, { _uuid: this.uuid })
    return result.status === 'ok'
  },

  async directThreadUnmute(threadId) {
    return this.directThreadMute(threadId, true)
  },

  async directMediaShare(
    mediaId,
    { userIds = [], threadIds = [], sendAttribute = 'feed_timeline', mediaType = 'photo' } = {}
  ) {
    requireLogin(this)
    const token = this.generateMutationToken()
    const users = idList(userIds)
    const threads = idList(threadIds)
    requireTarget(users, threads)
    if (!SEND_ATTRIBUTES_MEDIA.includes(sendAttribute)) {
      throw new ValidationError(`Unsupported sendAttribute="${sendAttribute}" ${SEND_ATTRIBUTES_MEDIA}`)
    }
    const kwargs = {
      action: 'send_item',
      is_shh_mode: '0',
      send_attribution: sendAttribute,
      client_context: token,
      media_id: await this.mediaId(mediaId),
      device_id: this.androidDeviceId,
      mutation_token: token,
      _uuid: this.uuid,
      btt_dual_send: 'false',
      nav_chain: NAV_CHAIN,
      is_ae_dual_send: 'false',
      offline_threading_id: token
    }
    if (users.length) kwargs.recipient_users = `[${bigintList(users)}]`
    if (threads.length) kwargs.thread_ids = bigintList(threads)
    if (['feed_contextual_chain', 'feed_short_url'].includes(sendAttribute)) {
      kwargs.inventory_source = 'recommended_explore_grid_cover_model'
    }
    if (sendAttribute === 'feed_timeline') kwargs.inventory_source = 'media_or_ad'
    const result = await this.privateRequest(
      'direct_v2/threads/broadcast/media_share/',
      this.withDefaultData(kwargs),
      { params: { media_type: mediaType }, withSignature: false }
    )
    if ((result.status ?? '') !== 'ok') throw new ClientError('media_share failed', result)
    return extractDirectMessage(result.payload)
  },

  async directStoryShare(storyId, { userIds = [], threadIds = [] } = {}) {
    requireLogin(this)
    const users = idList(userIds)
    const threads = idList(threadIds)
    requireTarget(users, threads)
    const id = await this.mediaId(storyId)
    const token = this.generateMutationToken()
    const data = {
      action: 'send_item',
      is_shh_mode: '0',
      send_attribution: 'reel_feed_timeline',
      client_context: token,
      mutation_token: token,
      nav_chain:
        '1qT:feed_timeline:1,ReelViewerFragment:reel_feed_timeline:4,DirectShareSheetFragment:direct_reshare_sheet:5',
      reel_id: this.mediaPk(id),
      containermodule: 'reel_feed_timeline',
      story_media_id: id,
      offline_threading_id: token
    }
    if (users.length) data.recipient_users = `[${bigintList(users)}]`
    if (threads.length) data.thread_ids = bigintList(threads)
    const result = await this.privateRequest(
      'direct_v2/threads/broadcast/story_share/',
      this.withDefaultData(data),
      { withSignature: false }
    )
    return extractDirectMessage(result.payload)
  },

  async directProfileShare(userId, { userIds = [], threadIds = [] } = {}) {
    requireLogin(this)
    const users = idList(userIds)
    const threads = idList(threadIds)
    requireTarget(users, threads)
    const token = this.generateMutationToken()
    const kwargs = {
      profile_user_id: userId,
      action: 'send_item',
      is_shh_mode: '0',
      send_attribution: 'profile',
      client_context: token,
      device_id: this.androidDeviceId,
      mutation_token: token,
      _uuid: this.uuid,
      btt_dual_send: 'false',
      nav_chain: NAV_CHAIN,
      is_ae_dual_send: 'false',
      offline_threading_id: token
    }
    if (users.length) kwargs.recipient_users = `[${bigintList(users)}]`
    if (threads.length) kwargs.thread_ids = bigintList(threads)
    const result = await this.privateRequest(
      'direct_v2/threads/broadcast/profile/',
      this.withDefaultData(kwargs),
      { withSignature: false }
    )
    if ((result.status ?? '') !== 'ok') throw new ClientError('profile share failed', result)
    return extractDirectMessage(result.payload)
  },

  async directSendCutoutSticker(stickerPk, { userIds = [], threadIds = [] } = {}) {
    requireLogin(this)
    const users = idList(userIds)
    const threads = idList(threadIds)
    requireTarget(users, threads)
    const token = this.generateMutationToken()
    const jsonParams = dumps({ sticker_id: `cutout_photo_${stickerPk}`, embedded_ent_type: 101 })
    const data = {
      action: 'send_item',
      embedded_ent_type: '101',
      json_params: jsonParams,
      client_context: token,
      mutation_token: token,
      device_id: this.androidDeviceId,
      _uuid: this.uuid,
      offline_threading_id: token
    }
    if (users.length) data.recipient_users = `[${bigintList(users)}]`
    if (threads.length) data.thread_ids = bigintList(threads)
    const result = await this.privateRequest(
      'direct_v2/threads/broadcast/generic_share/',
      this.withDefaultData(data),
      { withSignature: false }
    )
    return extractDirectMessage(result.payload)
  },

  messengerRuploadHeaders(extra = null) {
    const base = this.baseHeaders
    const userId = String(this.userId)
    const headers = {
      authorization: this.authorization,
      'ig-intended-user-id': userId,
      'ig-u-ds-user-id': userId,
      'accept-language': 'en-US',
      priority: 'u=6, i',
      'user-agent': this.userAgent,
      'x-fb-client-ip': 'True',
      'x-fb-friendly-name': 'undefined:media-upload',
      'x-fb-http-engine': 'Tigon/MNS/TCP',
      'x-fb-request-analytics-tags':
        '{"network_tags":{"product":"567067343352427","surface":"undefined","request_category":"media_upload","purpose":"none","retry_attempt":"0"}}',
      'x-fb-rmd': 'state=URL_ELIGIBLE',
      'x-fb-server-cluster': 'True',
      'x-tigon-is-retry': 'False',
      'x-ig-salt-ids': '51052545'
    }
    if (base['IG-U-RUR']) headers['ig-u-rur'] = base['IG-U-RUR']
    if (base['X-MID']) headers['x-mid'] = base['X-MID']
    return { ...headers, ...(extra ?? {}) }
  },

  async ruploadRequest(method, url, headers, body, timeout, label) {
    const response = await this.private.request(method, url, { headers, body, timeout, cookies: false })
    if (response.status !== 200) {
      throw new ClientError(`${label} failed: ${response.status} ${response.text.slice(0, 300)}`)
    }
    return response
  },

  async photoRupload(photoBytes, entityName) {
    const url = `https://rupload.facebook.com/messenger_image/${entityName}`
    const headers = {
      ...this.messengerRuploadHeaders({ image_type: 'FILE_ATTACHMENT' }),
      'content-type': 'application/octet-stream',
      offset: '0',
      'x-entity-length': String(photoBytes.length),
      'x-entity-name': entityName,
      'x-entity-type': 'image/jpeg'
    }
    const response = await this.ruploadRequest('POST', url, headers, photoBytes, 120000, 'messenger_image upload POST')
    const mediaId = parseJson(response.text).media_id
    if (!mediaId) throw new ClientError(`messenger_image response missing media_id: ${response.text.slice(0, 300)}`)
    return BigInt(mediaId)
  },

  async resumableRupload(kind, url, bytes, entityName, entityType, extraHeaders, timeout) {
    const headers = this.messengerRuploadHeaders(extraHeaders)
    const probe = await this.ruploadRequest('GET', url, headers, null, 30000, `${kind} offset GET`)
    const offset = Number(parseJson(probe.text).offset ?? 0) || 0
    const postHeaders = {
      ...headers,
      'content-type': 'application/octet-stream',
      offset: String(offset),
      'x-entity-length': String(bytes.length),
      'x-entity-name': entityName,
      'x-entity-type': entityType
    }
    const response = await this.ruploadRequest(
      'POST',
      url,
      postHeaders,
      bytes.subarray(offset),
      timeout,
      `${kind} upload POST`
    )
    const mediaId = parseJson(response.text).media_id
    if (!mediaId) throw new ClientError(`${kind} response missing media_id: ${response.text.slice(0, 300)}`)
    return BigInt(mediaId)
  },

  async videoRupload(videoBytes, entityName, waterfallId) {
    return this.resumableRupload(
      'messenger_video',
      `https://rupload.facebook.com/messenger_video/${entityName}`,
      videoBytes,
      entityName,
      'video/mp4',
      {
        video_type: 'FILE_ATTACHMENT',
        'segment-start-offset': '0',
        'segment-type': '3',
        ephemeral_media_view_mode: '2',
        ig_raven_metadata: '{}',
        x_fb_video_waterfall_id: waterfallId
      },
      300000
    )
  },

  async voiceRupload(audioBytes, uploadId, randKey) {
    const entity = `${uploadId}_0_${randKey}`
    return this.resumableRupload(
      'messenger_audio',
      `https://rupload.facebook.com/messenger_audio/${entity}`,
      audioBytes,
      entity,
      'audio/mp4',
      { audio_type: 'FILE_ATTACHMENT' },
      120000
    )
  },

  async resolveMediaThreads(userIds, threadIds, kind) {
    const users = idList(userIds)
    let threads = idList(threadIds)
    requireTarget(users, threads)
    if (users.length) threads = [await this.directThreadIdFromUserIds(users, kind)]
    return threads
  },

  async directSendPhoto(input, { userIds = [], threadIds = [] } = {}) {
    requireLogin(this)
    const threads = await this.resolveMediaThreads(userIds, threadIds, 'photo')
    const photoBytes = await prepareImage(await loadBytes(input))
    const entityName = `fb_uploader_${Date.now()}`
    const mediaId = await this.photoRupload(photoBytes, entityName)
    const token = this.generateMutationToken()
    const data = {
      action: 'send_item',
      is_x_transport_forward: 'false',
      is_shh_mode: '0',
      thread_ids: bigintList(threads),
      send_attribution: 'inbox',
      client_context: token,
      attachment_fbid: String(mediaId),
      device_id: this.androidDeviceId,
      mutation_token: token,
      _uuid: this.uuid,
      allow_full_aspect_ratio: 'true',
      btt_dual_send: 'false',
      is_ae_dual_send: 'false',
      offline_threading_id: token
    }
    const result = await this.privateRequest(
      'direct_v2/threads/broadcast/photo_attachment/',
      this.withDefaultData(data),
      { withSignature: false }
    )
    return extractDirectMessage(result.payload)
  },

  async directSendVideo(input, { userIds = [], threadIds = [] } = {}) {
    requireLogin(this)
    const threads = await this.resolveMediaThreads(userIds, threadIds, 'video')
    const videoBytes = await loadBytes(input)
    const size = videoBytes.length
    const { width, height, duration } = readMp4Metadata(videoBytes)
    const hexId = randomBytes(16).toString('hex')
    const ms = Date.now()
    const entity = `${hexId}-0-${size}-${ms}-${ms}`
    const uploadId = String(randomBetween(10 ** 11, 10 ** 12 - 1))
    const waterfallId = `${uploadId}_${hexId.slice(0, 12).toUpperCase()}_Mixed_0`
    const mediaId = await this.videoRupload(videoBytes, entity, waterfallId)
    const token = this.generateMutationToken()
    const now = Math.floor(Date.now() / 1000)
    const data = {
      recipient_users: '[]',
      view_mode: 'permanent',
      has_camera_metadata: '1',
      camera_entry_point: '3',
      thread_ids: dumps(threads.map(String)),
      reshare_mode: 'allow_reshare',
      original_media_type: '2',
      send_attribution: 'direct_composer',
      client_context: token,
      camera_session_id: randomUUID(),
      attachment_fbid: String(mediaId),
      include_e2ee_mentioned_user_list: '1',
      hide_from_profile_grid: 'false',
      timezone_offset: '0',
      client_shared_at: String(now),
      configure_mode: '2',
      source_type: '3',
      camera_position: 'back',
      video_result: String(mediaId),
      _uid: String(this.userId),
      device_id: this.androidDeviceId,
      composition_id: randomUUID(),
      mutation_token: token,
      _uuid: this.uuid,
      creation_surface: 'camera',
      has_ig_camera_edits: 'false',
      capture_type: 'normal',
      audience: 'default',
      upload_id: uploadId,
      client_timestamp: String(now),
      media_transformation_info: dumps({
        width: String(width),
        height: String(height),
        x_transform: '0',
        y_transform: '0',
        zoom: '1.0',
        rotation: '0.0',
        background_coverage: '0.0'
      }),
      clips: [{ length: duration, source_type: '3', camera_position: 'back' }],
      poster_frame_index: 0,
      length: duration,
      audio_muted: false,
      edits: { filter_type: 0, filter_strength: 1.0 },
      extra: { source_width: width, source_height: height },
      device: {
        manufacturer: 'Google',
        model: 'sdk_gphone_arm64',
        android_version: 30,
        android_release: '11'
      }
    }
    const result = await this.privateRequest(
      'direct_v2/threads/broadcast/raven_attachment/?video=1',
      this.withDefaultData(data),
      { withSignature: true }
    )
    return extractDirectMessage(result.payload)
  },

  async directSendVoice(input, { userIds = [], threadIds = [], waveform = null } = {}) {
    requireLogin(this)
    const threads = await this.resolveMediaThreads(userIds, threadIds, 'voice')
    const audioBytes = await loadBytes(input)
    const uploadId = String(Date.now())
    const randKey = randomBetween(-(2 ** 31), 2 ** 31 - 1)
    const mediaId = await this.voiceRupload(audioBytes, uploadId, randKey)
    const wave =
      waveform ?? Array.from({ length: 70 }, () => Math.round((0.2 + Math.random() * 0.75) * 1000) / 1000)
    const token = this.generateMutationToken()
    const data = {
      action: 'send_item',
      thread_ids: bigintList(threads),
      send_attribution: 'inbox',
      client_context: token,
      attachment_fbid: String(mediaId),
      device_id: this.androidDeviceId,
      mutation_token: token,
      _uuid: this.uuid,
      waveform: dumps(wave),
      waveform_sampling_frequency_hz: '10',
      upload_id: uploadId,
      offline_threading_id: token
    }
    const result = await this.privateRequest(
      'direct_v2/threads/broadcast/voice_attachment/',
      this.withDefaultData(data),
      { withSignature: false }
    )
    return extractDirectMessage(result.payload)
  },

  async directSendFile(input, { userIds = [], threadIds = [], contentType = 'photo' } = {}) {
    requireLogin(this)
    const users = idList(userIds)
    const threads = idList(threadIds)
    requireTarget(users, threads)
    if (contentType === 'photo') return this.directSendPhoto(input, { userIds: users, threadIds: threads })
    if (contentType === 'video') return this.directSendVideo(input, { userIds: users, threadIds: threads })
    throw new ValidationError('contentType must be "photo" or "video"')
  }
}
