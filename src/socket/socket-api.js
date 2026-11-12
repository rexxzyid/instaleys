import { DirectThreadNotFound, UserNotFound } from '../errors.js'
import { loadBytes } from '../media-utils.js'
import { DisconnectError, DisconnectReason, NotSupportedError } from './defaults.js'
import { S_GROUP, S_USER, groupJid, jidDecode, userJid } from './jid.js'
import {
  buildSentMessage,
  convertItem,
  generateMessageID,
  getContentType,
  normalizeMessageContent,
  toSeconds
} from './messages.js'

const MEDIA_KEYS = ['image', 'video', 'audio']
const UNSUPPORTED_KEYS = [
  'location',
  'poll',
  'contacts',
  'buttons',
  'listMessage',
  'templateButtons',
  'sticker',
  'document',
  'edit',
  'disappearingMessagesInChat',
  'viewOnce'
]

export const buildSocketApi = (rt) => {
  const { client, ev, logger, config, auth } = rt

  const ensureOpen = async () => {
    if (rt.closed) throw new DisconnectError('Connection closed', DisconnectReason.connectionClosed)
    if (rt.user) return
    await sock.waitForConnectionUpdate((update) => update.connection === 'open', 60000)
  }

  const resolveTarget = async (jid, { needThread = false } = {}) => {
    const decoded = jidDecode(jid)
    if (!decoded || ![S_USER, S_GROUP].includes(decoded.server)) throw new Error(`Invalid jid: ${jid}`)
    if (decoded.server === S_GROUP) return { jid, threadId: decoded.user, isGroup: true }
    let threadId = rt.jidThread.get(jid) ?? null
    if (!threadId && needThread) {
      try {
        threadId = String(await client.directThreadIdFromUserIds([decoded.user], 'message'))
        rt.jidThread.set(jid, threadId)
      } catch (error) {
        if (!(error instanceof DirectThreadNotFound)) throw error
      }
    }
    return { jid, userId: decoded.user, threadId, isGroup: false }
  }

  const requireThread = async (jid, hint = null) => {
    if (hint) return String(hint)
    const target = await resolveTarget(jid, { needThread: true })
    if (!target.threadId) throw new DirectThreadNotFound(`No direct thread found for ${jid}`)
    return target.threadId
  }

  const targetIds = (target) => (target.threadId ? { threadIds: [target.threadId] } : { userIds: [target.userId] })

  const rememberSent = async (threadId, message) => {
    rt.sentIds.add(message.key.id)
    setTimeout(() => rt.sentIds.delete(message.key.id), 300000).unref?.()
    if (!threadId) return
    const state = await rt.getThreadState(threadId)
    state.seen.add(message.key.id)
    state.recent.push({ id: message.key.id, ts: message.messageTimestamp, fromMe: true })
    rt.markDirty(threadId)
  }

  const finalize = async ({ content, sent, target, options }) => {
    const { selfJid, selfName } = rt.selfIdentity()
    const threadId = target.threadId ?? (sent?.thread_id ? String(sent.thread_id) : null)
    const message = buildSentMessage({
      content,
      sent,
      ctx: { chatJid: target.jid, threadId, selfJid, selfName },
      replyTo: options.quoted
    })
    await rememberSent(threadId, message)
    if (threadId) {
      rt.jidThread.set(target.jid, threadId)
      if (target.isGroup) rt.threadChat.set(threadId, { jid: target.jid, isGroup: true })
    }
    if (config.emitOwnEvents) {
      ev.emit('messages.upsert', { messages: [message], type: 'append' })
      ev.emit('chats.update', [{ id: target.jid, conversationTimestamp: message.messageTimestamp }])
    }
    return message
  }

  const sendMessage = async (jid, content, options = {}) => {
    await ensureOpen()
    if (typeof content === 'string') content = { text: content }
    for (const key of UNSUPPORTED_KEYS) {
      if (content[key] !== undefined) {
        throw new NotSupportedError(`"${key}" messages are not supported by the Instagram private API client`)
      }
    }

    if (content.react) {
      const { key, text = '' } = content.react
      const threadId = await requireThread(jid, key.threadId)
      const clientContext = options.quoted?.clientContext
      if (text) await client.directSendReaction(threadId, key.id, text, { clientContext })
      else await client.directDeleteReaction(threadId, key.id, content.react.previous ?? undefined, { clientContext })
      const { selfJid } = rt.selfIdentity()
      const reaction = {
        key: { remoteJid: jid, fromMe: true, id: key.id, participant: selfJid },
        text,
        senderTimestampMs: Date.now()
      }
      if (config.emitOwnEvents) ev.emit('messages.reaction', [{ key, reaction }])
      return {
        key: { remoteJid: jid, fromMe: true, id: generateMessageID(), threadId },
        message: { reactionMessage: { key, text } },
        messageTimestamp: toSeconds(new Date())
      }
    }

    if (content.delete) {
      const key = content.delete
      const threadId = await requireThread(key.remoteJid ?? jid, key.threadId)
      await client.directMessageDelete(threadId, key.id)
      const state = await rt.getThreadState(threadId)
      state.recent = state.recent.filter((entry) => entry.id !== key.id)
      rt.sentIds.add(key.id)
      rt.markDirty(threadId)
      if (config.emitOwnEvents) ev.emit('messages.delete', { keys: [key] })
      return { key, messageStubType: 'REVOKE', messageTimestamp: toSeconds(new Date()) }
    }

    if (content.forward) return forwardMessage(jid, content.forward, options)

    const mediaKind = MEDIA_KEYS.find((name) => content[name] !== undefined)
    const needsThread = Boolean(mediaKind)
    const target = await resolveTarget(jid, { needThread: needsThread })
    const ids = targetIds(target)

    if (mediaKind) {
      const source = content[mediaKind]
      let sent
      if (mediaKind === 'image') sent = await client.directSendPhoto(source, ids)
      else if (mediaKind === 'video') sent = await client.directSendVideo(source, ids)
      else sent = await client.directSendVoice(source, { ...ids, waveform: content.waveform ?? null })
      const message = await finalize({ content, sent, target, options })
      if (content.caption) {
        await sendMessage(jid, { text: content.caption }, {})
      }
      return message
    }

    if (content.mediaShare) {
      const { mediaId, type = 'photo', sendAttribute = 'feed_timeline' } = content.mediaShare
      const sent = await client.directMediaShare(mediaId, { ...ids, mediaType: type, sendAttribute })
      return finalize({ content, sent, target, options })
    }

    if (content.storyShare) {
      const sent = await client.directStoryShare(content.storyShare.storyId, ids)
      return finalize({ content, sent, target, options })
    }

    if (content.profile) {
      const pk = content.profile.userId ?? jidDecode(content.profile.jid)?.user
      const sent = await client.directProfileShare(String(pk), ids)
      return finalize({ content: { profile: { jid: userJid(pk) } }, sent, target, options })
    }

    if (typeof content.text === 'string') {
      const quoted = options.quoted
      const replyToMessage = quoted
        ? {
            id: quoted.key.id,
            client_context: quoted.clientContext ?? quoted.igItem?.client_context ?? ''
          }
        : null
      const sent = await client.directSend(content.text, { ...ids, replyToMessage })
      return finalize({ content, sent, target, options })
    }

    throw new NotSupportedError(`Unsupported message content: ${Object.keys(content).join(', ') || '(empty)'}`)
  }

  const forwardMessage = async (jid, message, options) => {
    const content = normalizeMessageContent(message.message)
    const type = getContentType(content)
    const body = content?.[type]
    switch (type) {
      case 'conversation':
        return sendMessage(jid, { text: content.conversation }, options)
      case 'extendedTextMessage':
        return sendMessage(jid, { text: body.text }, options)
      case 'mediaShareMessage':
        return sendMessage(jid, { mediaShare: { mediaId: body.mediaId, type: body.mediaType === 2 ? 'video' : 'photo' } }, options)
      case 'profileMessage':
        return sendMessage(jid, { profile: { jid: body.id } }, options)
      case 'imageMessage':
        return sendMessage(jid, { image: { url: body.url } }, options)
      case 'videoMessage':
        return sendMessage(jid, { video: { url: body.url } }, options)
      case 'audioMessage':
        return sendMessage(jid, { audio: { url: body.url } }, options)
      default:
        throw new NotSupportedError(`Cannot forward "${type}" messages`)
    }
  }

  const readMessages = async (keys) => {
    await ensureOpen()
    const latest = new Map()
    for (const key of keys) latest.set(key.remoteJid, key)
    for (const [jid, key] of latest) {
      const threadId = await requireThread(jid, key.threadId)
      await client.directMessageSeen(threadId, key.id)
      ev.emit('chats.update', [{ id: jid, unreadCount: 0 }])
      rt.chatSnapshots.get(jid) && (rt.chatSnapshots.get(jid).unreadCount = 0)
    }
  }

  const chatModify = async (mod, jid) => {
    await ensureOpen()
    const threadId = await requireThread(jid)
    if ('mute' in mod) {
      await client.directThreadMute(threadId, !mod.mute)
      ev.emit('chats.update', [{ id: jid, muteEndTime: mod.mute ? Number.MAX_SAFE_INTEGER : null }])
      return
    }
    if ('markRead' in mod) {
      if (mod.markRead) await client.directSendSeen(threadId)
      else await client.directThreadMarkUnread(threadId)
      ev.emit('chats.update', [{ id: jid, unreadCount: mod.markRead ? 0 : -1 }])
      return
    }
    if (mod.archive || mod.delete) {
      await client.directThreadHide(threadId, false)
      ev.emit('chats.delete', [jid])
      return
    }
    if (mod.spam) {
      await client.directThreadHide(threadId, true)
      ev.emit('chats.delete', [jid])
      return
    }
    if (mod.approve) {
      await client.directPendingApprove(threadId)
      ev.emit('chats.update', [{ id: jid, pending: false }])
      return
    }
    throw new NotSupportedError(`Unsupported chat modification: ${Object.keys(mod).join(', ')}`)
  }

  const resolvePk = async (input) => {
    const raw = String(input)
    if (/^\d+$/.test(raw)) return raw
    const decoded = jidDecode(raw)
    if (decoded?.server === S_USER) return decoded.user
    if (decoded?.server === S_GROUP) throw new Error('Expected a user, got a group jid')
    return (await client.userInfoByUsername(raw)).pk
  }

  const resolveMediaId = async (input) => {
    const raw = String(input)
    if (/instagram\.com/.test(raw)) return client.mediaId(client.mediaPkFromUrl(raw))
    return client.mediaId(raw)
  }

  const userForJid = async (jid) => client.userInfo(await resolvePk(jid))

  const groupMetadata = async (jid) => {
    await ensureOpen()
    const decoded = jidDecode(jid)
    if (decoded?.server !== S_GROUP) throw new Error('groupMetadata expects a group jid')
    const thread = await client.directThread(decoded.user, 1)
    return rt.buildGroup(thread, jid, rt.selfIdentity().selfPk)
  }

  const fetchMessageHistory = async (jid, count = 20) => {
    await ensureOpen()
    const threadId = await requireThread(jid)
    const thread = await client.directThread(threadId, count)
    const ctx = rt.contextFor(thread)
    const messages = thread.messages
      .map((item) => convertItem(item, ctx))
      .sort((a, b) => a.messageTimestamp - b.messageTimestamp)
    ev.emit('messaging-history.set', { chats: [], contacts: [], messages, isLatest: false, syncType: 'ON_DEMAND' })
    return messages
  }

  const presenceSubscribe = async (jid) => {
    await ensureOpen()
    const pk = await resolvePk(jid)
    const result = await client.directUsersPresence([pk])
    const entry = result.user_presence?.[pk] ?? {}
    const lastSeen = entry.last_activity_at_ms ? Math.floor(Number(entry.last_activity_at_ms) / 1000) : undefined
    const id = userJid(pk)
    ev.emit('presence.update', {
      id,
      presences: { [id]: { lastKnownPresence: entry.is_active ? 'available' : 'unavailable', lastSeen } }
    })
    return result
  }

  const onInstagram = async (...inputs) => {
    await ensureOpen()
    const results = []
    for (const input of inputs.flat()) {
      try {
        const raw = String(input)
        const decoded = jidDecode(raw)
        const user =
          decoded?.server === S_USER || /^\d+$/.test(raw)
            ? await client.userInfoV1(decoded?.user ?? raw)
            : await client.userInfoByUsernameV1(raw)
        results.push({ jid: userJid(user.pk), exists: true, username: user.username, name: user.full_name })
      } catch (error) {
        if (!(error instanceof UserNotFound)) throw error
        results.push({ jid: String(input), exists: false })
      }
    }
    return results
  }

  const groupCreate = async (subject, participants) => {
    await ensureOpen()
    const ids = participants.map((jid) => jidDecode(jid)?.user ?? jid)
    const threadId = await client.directThreadCreate(ids, subject)
    const jid = groupJid(threadId)
    rt.threadChat.set(threadId, { jid, isGroup: true })
    rt.jidThread.set(jid, threadId)
    const metadata = await groupMetadata(jid)
    ev.emit('groups.upsert', [metadata])
    return metadata
  }

  const groupParticipantsUpdate = async (jid, participants, action) => {
    await ensureOpen()
    if (action !== 'add') {
      throw new NotSupportedError(`Group participant action "${action}" is not available in the Instagram private API client`)
    }
    const threadId = await requireThread(jid)
    const ids = participants.map((item) => jidDecode(item)?.user ?? item)
    await client.directThreadAddUsers(threadId, ids)
    const added = ids.map(userJid)
    ev.emit('group-participants.update', { id: jid, participants: added, action: 'add' })
    return added.map((id) => ({ status: '200', jid: id }))
  }

  const instagram = {
    userInfo: async (who) => userForJid(who),
    followers: async (who, amount = 0) => client.userFollowersV1(await resolvePk(who), amount),
    following: async (who, amount = 0) => client.userFollowingV1(await resolvePk(who), amount),
    medias: async (who, amount = 0) => client.userMedias(await resolvePk(who), amount),
    clips: async (who, amount = 0) => client.userClips(await resolvePk(who), amount),
    stories: async (who, amount = null) => client.userStories(await resolvePk(who), amount),
    friendship: async (who) => client.userFriendshipV1(await resolvePk(who)),
    follow: async (who) => client.userFollow(await resolvePk(who)),
    unfollow: async (who) => client.userUnfollow(await resolvePk(who)),
    block: async (who) => client.userBlock(await resolvePk(who)),
    unblock: async (who) => client.userUnblock(await resolvePk(who)),
    removeFollower: async (who) => client.userRemoveFollower(await resolvePk(who)),
    closeFriendAdd: async (who) => client.closeFriendAdd(await resolvePk(who)),
    closeFriendRemove: async (who) => client.closeFriendRemove(await resolvePk(who)),
    followRequests: async (amount = 0) => client.userFollowRequests(amount),
    approveFollowRequest: async (who) => client.userFollowRequestApprove(await resolvePk(who)),
    declineFollowRequest: async (who) => client.userFollowRequestDecline(await resolvePk(who)),
    searchUsers: async (query, count = 50) => client.searchUsers(query, count),
    mediaInfo: async (media) => client.mediaInfoV1(client.mediaPk(await resolveMediaId(media))),
    like: async (media) => client.mediaLike(await resolveMediaId(media)),
    unlike: async (media) => client.mediaUnlike(await resolveMediaId(media)),
    likers: async (media) => client.mediaLikers(await resolveMediaId(media)),
    comment: async (media, text, repliedTo = null) => client.mediaComment(await resolveMediaId(media), text, repliedTo),
    comments: async (media, amount = 20) => client.mediaComments(await resolveMediaId(media), amount),
    commentReplies: async (media, commentId, amount = 0) =>
      client.mediaCommentReplies(await resolveMediaId(media), commentId, amount),
    likeComment: async (commentPk) => client.commentLike(commentPk),
    unlikeComment: async (commentPk) => client.commentUnlike(commentPk),
    deleteComments: async (media, commentPks) => client.commentBulkDelete(await resolveMediaId(media), commentPks),
    deleteMedia: async (media) => client.mediaDelete(await resolveMediaId(media)),
    editMedia: async (media, caption) => client.mediaEdit(await resolveMediaId(media), caption),
    storySeen: async (storyPks) => client.storySeen(storyPks),
    storyViewers: async (storyPk, amount = 0) => client.storyViewers(storyPk, amount),
    storyLikers: async (storyPk, amount = 0) => client.storyLikers(storyPk, amount),
    deleteStory: async (storyPk) => client.storyDelete(storyPk),
    hashtagInfo: async (name) => client.hashtagInfo(name),
    hashtagMedias: async (name, amount = 27, tab = 'top') => client.hashtagMediasV1(name, amount, tab),
    hashtagFollow: async (name) => client.hashtagFollow(name),
    hashtagUnfollow: async (name) => client.hashtagUnfollow(name),
    shareInfo: async (code) => client.shareInfo(code),
    shareInfoByUrl: async (url) => client.shareInfoByUrl(url),
    explore: async () => client.explorePage(),
    timeline: async (reason = 'pull_to_refresh') => client.getTimelineFeed(reason),
    reelsTray: async (reason = 'pull_to_refresh') => client.getReelsTrayFeed(reason),
    reels: async (amount = 10, lastMediaPk = 0) => client.reels(amount, lastMediaPk),
    exploreReels: async (amount = 10, lastMediaPk = 0) => client.exploreReels(amount, lastMediaPk),
    friendsReels: async (amount = 10, lastMediaPk = 0) => client.friendsReels(amount, lastMediaPk),
    locationSearch: async (lat, lng) => client.locationSearch(lat, lng),
    locationInfo: async (locationPk) => client.locationInfo(locationPk),
    locationMedias: async (locationPk, amount = 63, tabKey = 'ranked') =>
      client.locationMediasV1(locationPk, amount, tabKey),
    locationMediasTop: async (locationPk, amount = 27) => client.locationMediasTop(locationPk, amount),
    locationMediasRecent: async (locationPk, amount = 63) => client.locationMediasRecent(locationPk, amount),
    locationGuides: async (locationPk) => client.locationGuidesV1(locationPk),
    userHighlights: async (who, amount = 0) => client.userHighlightsV1(await resolvePk(who), amount),
    highlightInfo: async (highlightPk) => client.highlightInfoV1(highlightPk),
    highlightCreate: async (title, storyIds, options = {}) => client.highlightCreate(title, storyIds, options),
    highlightChangeTitle: async (highlightPk, title) => client.highlightChangeTitle(highlightPk, title),
    highlightAddStories: async (highlightPk, addedMediaIds) => client.highlightAddStories(highlightPk, addedMediaIds),
    highlightRemoveStories: async (highlightPk, removedMediaIds) =>
      client.highlightRemoveStories(highlightPk, removedMediaIds),
    highlightDelete: async (highlightPk) => client.highlightDelete(highlightPk),
    notes: async () => client.getNotes(),
    createNote: async (text, options = {}) => client.createNote(text, options),
    createMusicNote: async (track, text = '', options = {}) => client.createMusicNote(track, text, options),
    deleteNote: async (noteId) => client.deleteNote(noteId),
    updateNotesLastSeen: async () => client.lastSeenUpdateNote(),
    insightsAccount: async () => client.insightsAccount(),
    insightsMedia: async (mediaId) => client.insightsMedia(mediaId),
    insightsMediaFeedAll: async (options = {}) => client.insightsMediaFeedAll(options),
    collections: async () => client.collections(),
    collectionPkByName: async (name) => client.collectionPkByName(name),
    collectionMedias: async (collectionPk, amount = 21, lastMediaPk = 0) =>
      client.collectionMedias(collectionPk, amount, lastMediaPk),
    likedMedias: async (amount = 21, lastMediaPk = 0) => client.likedMedias(amount, lastMediaPk),
    saveMedia: async (media, collectionPk = null) => client.mediaSave(await resolveMediaId(media), collectionPk),
    unsaveMedia: async (media, collectionPk = null) => client.mediaUnsave(await resolveMediaId(media), collectionPk),
    accountInfo: async () => client.accountInfo(),
    editAccount: async (fields) => client.accountEdit(fields),
    setPrivate: async () => client.accountSetPrivate(),
    setPublic: async () => client.accountSetPublic()
  }

  const sock = {
    type: 'instagram',
    ev,
    authState: auth,
    client,
    logger,
    config,
    instagram,
    get user() {
      return rt.user
    },

    waitForConnectionUpdate: (check, timeoutMs = 0) =>
      new Promise((resolve, reject) => {
        let timer = null
        const listener = (update) => {
          if (!check(update)) return
          cleanup()
          resolve(update)
        }
        const cleanup = () => {
          clearTimeout(timer)
          ev.off('connection.update', listener)
        }
        ev.on('connection.update', listener)
        if (timeoutMs) {
          timer = setTimeout(() => {
            cleanup()
            reject(new DisconnectError('Timed out waiting for connection update', DisconnectReason.timedOut))
          }, timeoutMs)
        }
      }),

    end: (error) => rt.close(error ?? new DisconnectError('Connection closed', DisconnectReason.connectionClosed)),

    logout: async (message) => {
      try {
        await client.logout()
      } catch (error) {
        logger.debug({ err: error }, 'logout request failed')
      }
      rt.updateCreds({ settings: null, me: null, registered: false })
      await auth.keys?.clear?.()
      rt.close(new DisconnectError(message ?? 'Intentional Logout', DisconnectReason.loggedOut))
    },

    sendMessage,
    readMessages,
    chatModify,
    fetchMessageHistory,
    presenceSubscribe,

    sendPresenceUpdate: async () => {
      logger.debug('sendPresenceUpdate is a no-op: no typing-indicator endpoint is available')
    },

    onInstagram,
    onWhatsApp: onInstagram,

    fetchStatus: async (jid) => {
      await ensureOpen()
      const user = await userForJid(jid)
      return { status: user.biography ?? '', setAt: null }
    },

    profilePictureUrl: async (jid, type = 'preview') => {
      await ensureOpen()
      const user = await userForJid(jid)
      return type === 'image' ? (user.profile_pic_url_hd ?? user.profile_pic_url) : user.profile_pic_url
    },

    getBusinessProfile: async (jid) => {
      await ensureOpen()
      const user = await userForJid(jid)
      return {
        wid: userJid(user.pk),
        description: user.biography ?? '',
        category: user.category ?? null,
        email: user.public_email ?? null,
        phone: user.contact_phone_number ?? null,
        website: user.external_url ? [user.external_url] : [],
        isBusiness: Boolean(user.is_business)
      }
    },

    updateBlockStatus: async (jid, action) => {
      await ensureOpen()
      const pk = await resolvePk(jid)
      return action === 'block' ? client.userBlock(pk) : client.userUnblock(pk)
    },

    updateProfileStatus: async (status) => {
      await ensureOpen()
      return client.accountSetBiography(status)
    },

    updateProfileName: async (name) => {
      await ensureOpen()
      return client.accountEdit({ full_name: name })
    },

    updateProfilePicture: async () => {
      throw new NotSupportedError('Changing the profile picture is not available in this client')
    },

    searchUsers: async (query) => {
      await ensureOpen()
      const users = await client.directSearch(query)
      return users.map(rt.buildContact)
    },

    fetchMessageRequests: async (amount = 20) => {
      await ensureOpen()
      const threads = await client.directPendingInbox(amount)
      return threads.map((thread) => rt.buildChat(thread, rt.chatIdentity(thread), [], rt.selfIdentity().selfPk))
    },

    acceptMessageRequest: async (jid) => {
      await ensureOpen()
      const threadId = rt.jidThread.get(jid) ?? (await requireThread(jid))
      const ok = await client.directPendingApprove(threadId)
      if (ok) ev.emit('chats.update', [{ id: jid, pending: false }])
      return ok
    },

    fetchSpamInbox: async (amount = 20) => {
      await ensureOpen()
      const threads = await client.directSpamInbox(amount)
      return threads.map((thread) => rt.buildChat(thread, rt.chatIdentity(thread), [], rt.selfIdentity().selfPk))
    },

    fetchActivePresence: async () => {
      await ensureOpen()
      return client.directActivePresence()
    },

    groupMetadata,

    groupFetchAllParticipating: async (amount = 100) => {
      await ensureOpen()
      const threads = await client.directThreads(amount, { threadMessageLimit: 1 })
      const { selfPk } = rt.selfIdentity()
      const result = {}
      for (const thread of threads) {
        const identity = rt.chatIdentity(thread)
        if (identity.isGroup) result[identity.jid] = rt.buildGroup(thread, identity.jid, selfPk)
      }
      return result
    },

    groupCreate,

    groupUpdateSubject: async (jid, subject) => {
      await ensureOpen()
      const threadId = await requireThread(jid)
      await client.directThreadUpdateTitle(threadId, subject)
      ev.emit('groups.update', [{ id: jid, subject }])
    },

    groupParticipantsUpdate,

    groupLeave: async () => {
      throw new NotSupportedError('Leaving a group is not available in the Instagram private API client')
    },

    resolveJid: async (input) => {
      const raw = String(input)
      if (jidDecode(raw)) return raw
      return userJid(await resolvePk(raw))
    },

    refreshSession: async () => {
      await client.relogin()
      rt.syncSettings()
    }
  }

  return sock
}
