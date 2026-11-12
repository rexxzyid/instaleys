import { ValidationError } from '../errors.js'

const MUTE_ALL_ITEMS = ['cancel', '15_minutes', '1_hour', '2_hour', '4_hour', '8_hour']
const SETTING_VALUE_ITEMS = ['off', 'following_only', 'everyone']

const CONTENT_TYPES = {
  notificationLikes: 'likes',
  notificationLikeAndCommentOnPhotoUserTagged: 'like_and_comment_on_photo_user_tagged',
  notificationUserTagged: 'user_tagged',
  notificationComments: 'comments',
  notificationCommentLikes: 'comment_likes',
  notificationFirstPost: 'first_post',
  notificationNewFollower: 'new_follower',
  notificationFollowRequestAccepted: 'follow_request_accepted',
  notificationConnection: 'connection_notification',
  notificationTaggedInBio: 'tagged_in_bio',
  notificationPendingDirectShare: 'pending_direct_share',
  notificationDirectShareActivity: 'direct_share_activity',
  notificationDirectGroupRequests: 'direct_group_requests',
  notificationVideoCall: 'video_call',
  notificationRooms: 'rooms',
  notificationLiveBroadcast: 'live_broadcast',
  notificationFelixUploadResult: 'felix_upload_result',
  notificationViewCount: 'view_count',
  notificationFundraiserCreator: 'fundraiser_creator',
  notificationFundraiserSupporter: 'fundraiser_supporter',
  notificationReminders: 'notification_reminders',
  notificationAnnouncements: 'announcements',
  notificationReportUpdated: 'report_updated',
  notificationLogin: 'login_notification'
}

const requireOneOf = (value, allowed) => {
  if (!allowed.includes(value)) {
    throw new ValidationError(`Unsupported setting_value="${value}" ${JSON.stringify(allowed)}`)
  }
}

const settingMethods = Object.fromEntries(
  Object.entries(CONTENT_TYPES).map(([name, contentType]) => [
    name,
    async function (settingValue = 'off') {
      requireOneOf(settingValue, SETTING_VALUE_ITEMS)
      return this.notificationSettings(contentType, settingValue)
    }
  ])
)

export const notificationMixin = {
  async notificationSettings(contentType, settingValue) {
    const data = {
      content_type: contentType,
      setting_value: settingValue,
      _uid: String(this.userId),
      _uuid: this.uuid
    }
    const result = await this.privateRequest('notifications/change_notification_settings/', data)
    return result.status === 'ok'
  },

  async notificationDisable() {
    for (const name of Object.keys(CONTENT_TYPES)) {
      if (!(await this[name]('off'))) return false
    }
    return true
  },

  async notificationMuteAll(settingValue = '8_hour') {
    requireOneOf(settingValue, MUTE_ALL_ITEMS)
    return this.notificationSettings('mute_all', settingValue)
  },

  ...settingMethods
}

export const multipleAccountsMixin = {
  async featuredAccountsV1(targetUserId) {
    return this.privateRequest('multiple_accounts/get_featured_accounts/', null, {
      params: { target_user_id: String(targetUserId) }
    })
  },

  async getAccountFamilyV1() {
    return this.privateRequest('multiple_accounts/get_account_family/')
  }
}
