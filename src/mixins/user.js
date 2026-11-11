import {
  ClientError,
  ClientNotFoundError,
  UserNotFound,
  ValidationError
} from '../errors.js'
import { extractUserShort, extractUserV1 } from '../extractors.js'

const MAX_USER_COUNT = 200
const INFO_FROM_MODULES = ['self_profile', 'feed_timeline', 'reel_feed_timeline']

const normalizeUsername = (username) => String(username).trim().replace(/^@/, '').toLowerCase()

export const userMixin = {
  async userInfoByUsernameV1(username) {
    const name = normalizeUsername(username)
    let result
    try {
      result = await this.privateRequest(`users/${name}/usernameinfo/`)
    } catch (error) {
      if (error instanceof ClientNotFoundError || String(error.message).includes('User not found')) {
        throw new UserNotFound(error.message, { username: name, ...this.lastJson })
      }
      throw error
    }
    return extractUserV1(result.user)
  },

  async userInfoByUsername(username, useCache = true) {
    const name = normalizeUsername(username)
    if (!useCache || !this.usernamesCache.has(name)) {
      const user = await this.userInfoByUsernameV1(name)
      this.usernamesCache.set(name, user.pk)
      this.usersCache.set(user.pk, user)
    }
    return structuredClone(this.usersCache.get(this.usernamesCache.get(name)))
  },

  async userIdFromUsername(username) {
    return (await this.userInfoByUsername(username)).pk
  },

  async userInfoV1(userId, { fromModule = 'self_profile', isAppStart = false } = {}) {
    const id = String(userId)
    if (!INFO_FROM_MODULES.includes(fromModule)) {
      throw new ValidationError(`Unsupported fromModule="${fromModule}" ${INFO_FROM_MODULES}`)
    }
    const params = {
      is_prefetch: 'false',
      entry_point: fromModule === 'self_profile' ? 'self_profile' : 'profile',
      from_module: fromModule,
      is_app_start: isAppStart
    }
    let result
    try {
      result = await this.privateRequest(`users/${id}/info/`, null, { params })
    } catch (error) {
      if (error instanceof ClientNotFoundError || String(error.message).includes('User not found')) {
        throw new UserNotFound(error.message, { user_id: id, ...this.lastJson })
      }
      throw error
    }
    return extractUserV1(result.user)
  },

  async userInfo(userId, useCache = true) {
    const id = String(userId)
    if (!useCache || !this.usersCache.has(id)) {
      const user = await this.userInfoV1(id)
      this.usersCache.set(id, user)
      this.usernamesCache.set(user.username.toLowerCase(), id)
    }
    return structuredClone(this.usersCache.get(id))
  },

  async usernameFromUserId(userId) {
    return (await this.userInfo(userId)).username
  },

  async userFriendshipsV1(userIds) {
    const result = await this.privateRequest(
      'friendships/show_many/',
      { user_ids: userIds.join(','), _uuid: this.uuid },
      { withSignature: false }
    )
    return Object.entries(result.friendship_statuses ?? {}).map(([userId, status]) => ({
      user_id: userId,
      ...status
    }))
  },

  async userFriendshipV1(userId) {
    try {
      const result = await this.privateRequest(`friendships/show/${userId}/`, null, {
        params: { is_external_deeplink_profile_view: 'false' }
      })
      if (result.status !== 'ok') return null
      return { user_id: String(userId), ...result }
    } catch (error) {
      if (!(error instanceof ClientError)) throw error
      this.logger.error(error)
      return null
    }
  },

  async searchUsersV1(query, count = 50) {
    const results = await this.privateRequest('users/search/', null, { params: { query, count } })
    return (results.users ?? []).map(extractUserShort)
  },

  async searchUsers(query, count = 50) {
    return this.searchUsersV1(query, count)
  },

  async searchFollowersV1(userId, query) {
    const result = await this.privateRequest(`friendships/${userId}/followers/`, null, {
      params: { search_surface: 'follow_list_page', query, enable_groups: 'true' }
    })
    return (result.users ?? []).map(extractUserShort)
  },

  async searchFollowingV1(userId, query) {
    const result = await this.privateRequest(`friendships/${userId}/following/`, null, {
      params: {
        includes_hashtags: 'false',
        search_surface: 'follow_list_page',
        query,
        enable_groups: 'true'
      }
    })
    return (result.users ?? []).map(extractUserShort)
  },

  async userFollowingV1Chunk(userId, maxAmount = 0, maxId = '') {
    const unique = new Set()
    const users = []
    let cursor = maxId
    while (true) {
      const count = maxAmount ? Math.min(maxAmount - users.length, MAX_USER_COUNT) : MAX_USER_COUNT
      const params = {
        count,
        rank_token: this.rankToken,
        search_surface: 'follow_list_page',
        query: '',
        enable_groups: 'true'
      }
      if (cursor) params.max_id = cursor
      const result = await this.privateRequest(`friendships/${userId}/following/`, null, { params })
      for (const raw of result.users) {
        const user = extractUserShort(raw)
        if (unique.has(user.pk)) continue
        unique.add(user.pk)
        users.push(user)
      }
      cursor = result.next_max_id
      if (!cursor || (maxAmount && users.length >= maxAmount)) break
    }
    return [users, cursor]
  },

  async userFollowingV1(userId, amount = 0) {
    const [users] = await this.userFollowingV1Chunk(String(userId), amount)
    return amount ? users.slice(0, amount) : users
  },

  async *iterUserFollowingV1(userId, { amount = 0, pageSize = 0 } = {}) {
    let cursor = ''
    let yielded = 0
    while (true) {
      const remaining = amount ? amount - yielded : 0
      if (amount && remaining <= 0) return
      const size = pageSize ? (amount ? Math.min(pageSize, remaining) : pageSize) : remaining
      const [users, next] = await this.userFollowingV1Chunk(String(userId), size, cursor)
      for (const user of users) {
        yield user
        yielded += 1
        if (amount && yielded >= amount) return
      }
      if (!next || next === cursor) return
      cursor = next
    }
  },

  async userFollowing(userId, { useCache = true, amount = 0 } = {}) {
    const id = String(userId)
    if (!useCache || !this.usersFollowing?.has(id)) {
      const users = await this.userFollowingV1(id, amount)
      this.usersFollowing ??= new Map()
      this.usersFollowing.set(id, new Map(users.map((user) => [user.pk, user])))
    }
    const all = [...this.usersFollowing.get(id).values()]
    return Object.fromEntries((amount ? all.slice(0, amount) : all).map((user) => [user.pk, user]))
  },

  async userFollowersV1Chunk(userId, maxAmount = 0, maxId = '', order = null) {
    const unique = new Set()
    const users = []
    let cursor = maxId
    while (true) {
      const count = maxAmount ? Math.min(maxAmount - users.length, MAX_USER_COUNT) : MAX_USER_COUNT
      const params = {
        count,
        rank_token: this.rankToken,
        search_surface: 'follow_list_page',
        query: '',
        enable_groups: 'true'
      }
      if (order) params.order = order
      if (cursor) params.max_id = cursor
      const result = await this.privateRequest(`friendships/${userId}/followers/`, null, { params })
      for (const raw of result.users) {
        const user = extractUserShort(raw)
        if (unique.has(user.pk)) continue
        unique.add(user.pk)
        users.push(user)
      }
      cursor = result.next_max_id
      if (!cursor || (maxAmount && users.length >= maxAmount)) break
    }
    return [users, cursor]
  },

  async userFollowersV1(userId, amount = 0, order = null) {
    const [users] = await this.userFollowersV1Chunk(String(userId), amount, '', order)
    return amount ? users.slice(0, amount) : users
  },

  async *iterUserFollowersV1(userId, { amount = 0, pageSize = 0, order = null } = {}) {
    let cursor = ''
    let yielded = 0
    while (true) {
      const remaining = amount ? amount - yielded : 0
      if (amount && remaining <= 0) return
      const size = pageSize ? (amount ? Math.min(pageSize, remaining) : pageSize) : remaining
      const [users, next] = await this.userFollowersV1Chunk(String(userId), size, cursor, order)
      for (const user of users) {
        yield user
        yielded += 1
        if (amount && yielded >= amount) return
      }
      if (!next || next === cursor) return
      cursor = next
    }
  },

  async userFollowers(userId, { useCache = true, amount = 0 } = {}) {
    const id = String(userId)
    if (!useCache || !this.usersFollowers?.has(id)) {
      const users = await this.userFollowersV1(id, amount)
      this.usersFollowers ??= new Map()
      this.usersFollowers.set(id, new Map(users.map((user) => [user.pk, user])))
    }
    const all = [...this.usersFollowers.get(id).values()]
    return Object.fromEntries((amount ? all.slice(0, amount) : all).map((user) => [user.pk, user]))
  },

  async userFollow(userId) {
    if (!this.userId) throw new ValidationError('Login required')
    const id = String(userId)
    const currentUserId = String(this.userId)
    const followingCache = this.usersFollowing?.get(currentUserId)
    if (followingCache?.has(id)) return false
    const relationship = await this.userFriendshipV1(id)
    if (relationship && (relationship.following || relationship.outgoing_request)) return false
    const data = this.withActionData({
      user_id: id,
      _uid: currentUserId,
      include_follow_friction_check: '1',
      container_module: 'profile'
    })
    const result = await this.privateRequest(`friendships/create/${id}/`, data)
    const status = result.friendship_status
    const followed = status.following === true || status.outgoing_request === true
    if (followed && followingCache) followingCache.set(id, { pk: id })
    return followed
  },

  async userUnfollow(userId) {
    if (!this.userId) throw new ValidationError('Login required')
    const id = String(userId)
    const data = this.withActionData({
      user_id: id,
      _uid: String(this.userId),
      container_module: 'profile'
    })
    const result = await this.privateRequest(`friendships/destroy/${id}/`, data)
    this.usersFollowing?.get(String(this.userId))?.delete(id)
    return result.friendship_status.following === false
  },

  async userBlock(userId, surface = 'profile') {
    const id = String(userId)
    const data = {
      surface,
      is_auto_block_enabled: 'false',
      user_id: id,
      _uid: String(this.userId),
      _uuid: this.uuid
    }
    if (surface === 'direct_thread_info') data.client_request_id = this.requestId
    const result = await this.privateRequest(`friendships/block/${id}/`, data)
    if (result.status !== 'ok') throw new ValidationError('Block request failed')
    return result.friendship_status?.blocking === true
  },

  async userUnblock(userId, surface = 'profile') {
    const id = String(userId)
    const data = {
      container_module: surface,
      user_id: id,
      _uid: String(this.userId),
      _uuid: this.uuid
    }
    if (surface === 'direct_thread_info') data.client_request_id = this.requestId
    const result = await this.privateRequest(`friendships/unblock/${id}/`, data)
    if (result.status !== 'ok') throw new ValidationError('Unblock request failed')
    return result.friendship_status?.blocking === false
  },

  async userRemoveFollower(userId) {
    if (!this.userId) throw new ValidationError('Login required')
    const id = String(userId)
    const result = await this.privateRequest(
      `friendships/remove_follower/${id}/`,
      this.withActionData({ user_id: id })
    )
    this.usersFollowers?.get(String(this.userId))?.delete(id)
    return result.friendship_status.followed_by === false
  },

  async userFollowRequestsChunk(maxAmount = 0, maxId = '') {
    if (!this.userId) throw new ValidationError('Login required')
    const users = []
    const unique = new Set()
    let cursor = maxId
    while (true) {
      const params = { count: maxAmount || MAX_USER_COUNT }
      if (cursor) params.max_id = cursor
      const result = await this.privateRequest('friendships/pending/', null, { params })
      for (const raw of result.users ?? []) {
        const user = extractUserShort(raw)
        if (unique.has(user.pk)) continue
        unique.add(user.pk)
        users.push(user)
      }
      cursor = result.next_max_id
      if (!cursor || (maxAmount && users.length >= maxAmount)) break
    }
    return [users, cursor]
  },

  async userFollowRequests(amount = 0) {
    const [users] = await this.userFollowRequestsChunk(amount)
    return amount ? users.slice(0, amount) : users
  },

  async userFollowRequestApprove(userId) {
    if (!this.userId) throw new ValidationError('Login required')
    const id = String(userId)
    const result = await this.privateRequest(`friendships/approve/${id}/`, this.withActionData({ user_id: id }))
    const status = result.friendship_status ?? {}
    if ('followed_by' in status) return status.followed_by === true
    return result.status === 'ok'
  },

  async userFollowRequestDecline(userId) {
    if (!this.userId) throw new ValidationError('Login required')
    const id = String(userId)
    const result = await this.privateRequest(`friendships/ignore/${id}/`, this.withActionData({ user_id: id }))
    const status = result.friendship_status ?? {}
    if ('followed_by' in status) return status.followed_by === false
    return result.status === 'ok'
  },

  async closeFriendAdd(userId) {
    if (!this.userId) throw new ValidationError('Login required')
    const id = String(userId)
    const data = {
      block_on_empty_thread_creation: 'false',
      module: 'CLOSE_FRIENDS_V2_SEARCH',
      source: 'audience_manager',
      _uid: this.userId,
      _uuid: this.uuid,
      remove: [],
      add: [id]
    }
    const result = await this.privateRequest('friendships/set_besties/', data)
    return result.friendship_statuses?.[id]?.is_bestie ?? null
  },

  async closeFriendRemove(userId) {
    if (!this.userId) throw new ValidationError('Login required')
    const id = String(userId)
    const data = {
      block_on_empty_thread_creation: 'false',
      module: 'CLOSE_FRIENDS_V2_SEARCH',
      source: 'audience_manager',
      _uid: this.userId,
      _uuid: this.uuid,
      remove: [id],
      add: []
    }
    const result = await this.privateRequest('friendships/set_besties/', data)
    return result.friendship_statuses?.[id]?.is_bestie === false
  }
}
