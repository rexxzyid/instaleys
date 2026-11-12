import { InstagramIdCodec } from './utils.js'

const clone = (value) => (value === undefined ? value : structuredClone(value))

const bestByArea = (items) =>
  [...items].sort((a, b) => a.height * a.width - b.height * b.width).at(-1)

const microsecondsToDate = (value) => new Date(Math.floor(Number(value) / 1000))

export const extractUserShort = (input) => {
  const data = { ...input }
  data.pk = String(data.id ?? data.pk ?? '')
  if (!data.pk) throw new Error(`User without pk "${JSON.stringify(input)}"`)
  if (data.latest_reel_media === undefined && data['1llatest_reel_media'] !== undefined) {
    data.latest_reel_media = data['1llatest_reel_media']
  }
  const status = data.friendship_status
  if (status && typeof status === 'object') {
    data.friendship_status = {
      user_id: data.pk,
      following: false,
      incoming_request: false,
      is_bestie: false,
      is_feed_favorite: false,
      is_private: false,
      is_restricted: false,
      outgoing_request: false,
      ...status
    }
  }
  return data
}

export const extractViewer = (input) => {
  const { user, ...rest } = input
  return { ...extractUserShort(user), ...rest }
}

export const extractBroadcastChannel = (data) =>
  data?.pinned_channels_info?.pinned_channels_list ?? []

export const extractUserV1 = (input) => {
  const data = { ...input }
  data.pk = String(data.pk ?? data.id)
  data.broadcast_channel = extractBroadcastChannel(data)
  data.external_url = data.external_url || null
  data.public_email = data.public_email || data.business_email
  data.contact_phone_number = data.contact_phone_number || data.business_phone_number
  const versions = data.hd_profile_pic_versions
  const picHd = versions?.length ? versions.at(-1) : (data.hd_profile_pic_url_info ?? {})
  data.profile_pic_url_hd = picHd.url
  return data
}

export const extractAccount = (input) => ({
  ...input,
  pk: String(input.pk),
  external_url: input.external_url || null
})

export const extractLocation = (input) => {
  if (!input) return null
  let data = { ...input }
  const placeLocation = data.place?.location
  if (data.place && typeof data.place === 'object' && placeLocation) data = { ...placeLocation }
  data.pk = data.id ?? data.pk ?? data.location_id ?? null
  const externalId = data.external_id || data.facebook_places_id
  data.external_id = [null, undefined, '', 'None'].includes(externalId) ? null : Number(externalId)
  data.external_id_source = data.external_id_source ?? data.external_source
  data.address = data.address ?? data.location_address
  data.city = data.city ?? data.location_city
  data.zip = data.zip ?? data.location_zip
  const addressJson = data.address_json ?? '{}'
  if (typeof addressJson === 'string') {
    try {
      const address = JSON.parse(addressJson)
      if (address && typeof address === 'object' && Object.keys(address).length) {
        data.address = address.street_address
        data.city = address.city_name
        data.zip = address.zip_code
      }
    } catch {
      data.address = data.address ?? null
    }
  }
  return data
}

export const extractUsertag = (data) => {
  const [x, y] = data.position ?? [data.x, data.y]
  return { user: extractUserShort(data.user), x, y }
}

const extractUsertags = (usertags) =>
  (usertags?.in ?? [])
    .map(extractUsertag)
    .sort((a, b) => (a.user.pk < b.user.pk ? -1 : a.user.pk > b.user.pk ? 1 : 0))

export const extractResourceV1 = (input) => {
  const data = clone(input)
  if (data.video_versions?.length) data.video_url = bestByArea(data.video_versions).url
  const candidates = data.image_versions2?.candidates ?? []
  data.thumbnail_url = candidates.length ? bestByArea(candidates).url : null
  data.usertags = extractUsertags(data.usertags)
  data.pk = String(data.pk)
  return data
}

export const extractMediaV1 = (input) => {
  const media = clone(input)
  if (media.crosspost === undefined || media.crosspost === null) media.crosspost = []
  if (media.video_versions?.length) media.video_url = bestByArea(media.video_versions).url
  if (media.media_type === 2 && !media.product_type) media.product_type = 'feed'
  if (media.image_versions2) {
    media.thumbnail_url = bestByArea(media.image_versions2.candidates).url
    const scrubber = media.image_versions2.scrubber_spritesheet_info_candidates ?? {}
    if (scrubber.default && !scrubber.default.sprite_urls) {
      delete media.image_versions2.scrubber_spritesheet_info_candidates
    }
  }
  if (media.media_type === 8) {
    delete media.thumbnail_url
    delete media.video_url
  }
  media.location = media.location ? extractLocation(media.location) : media.location
  media.user = extractUserShort(media.user)
  media.usertags = extractUsertags(media.usertags)
  media.like_count = media.like_count ?? 0
  media.has_liked = media.has_liked ?? false
  media.sponsor_tags = (media.sponsor_tags ?? []).map((tag) => extractUserShort(tag.sponsor))
  media.view_count = media.view_count ?? media.video_view_count ?? 0
  media.play_count = media.play_count ?? media.video_play_count ?? 0
  media.coauthor_producers = (media.coauthor_producers ?? []).map(extractUserShort)
  media.caption_text = media.caption?.text ?? ''
  media.resources = (media.carousel_media ?? []).map(extractResourceV1)
  media.pk = String(media.pk)
  media.id = String(media.id)
  return media
}

export const extractComment = (input) => ({
  ...input,
  pk: String(input.pk),
  has_liked: input.has_liked_comment,
  like_count: input.comment_like_count
})

export const extractHashtagV1 = (input) => ({
  ...input,
  allow_following: input.allow_following === 1,
  profile_pic_url: input.profile_pic_url || null
})

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

const unescapeHtml = (value) =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return HTML_ENTITIES[entity.toLowerCase()] ?? match
    const hex = entity[1].toLowerCase() === 'x'
    return String.fromCodePoint(parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10))
  })

export const extractTrack = (input) => {
  const data = clone(input)
  data.cover_artwork_uri = data.cover_artwork_uri || null
  data.cover_artwork_thumbnail_uri = data.cover_artwork_thumbnail_uri || null
  const match = /<BaseURL>(.+?)<\/BaseURL>/.exec(data.dash_manifest ?? '')
  data.uri = match ? unescapeHtml(match[1]) : null
  data.territory_validity_periods = data.territory_validity_periods || {}
  return data
}

export const extractCollection = (input) => {
  const data = {}
  for (const [key, value] of Object.entries(input)) data[key.replace(/^collection_/, '')] = value
  return {
    id: String(data.id),
    name: data.name,
    type: data.type,
    media_count: data.media_count
  }
}

export const extractHighlightV1 = (input) => {
  const data = clone(input)
  data.pk = String(data.id).split(':')[1]
  if (data.user && typeof data.user === 'object') data.user = extractUserShort(data.user)
  data.items = (data.items ?? []).map(extractStoryV1)
  return data
}

export const extractGuideV1 = (input) => {
  const data = clone(input.summary ?? {})
  data.cover_media = extractMediaV1(data.cover_media)
  return data
}

export const extractDirectMedia = (input) => {
  const media = clone(input)
  if (media.video_versions?.length) media.video_url = bestByArea(media.video_versions).url
  if (media.image_versions2) media.thumbnail_url = bestByArea(media.image_versions2.candidates).url
  if (media.user) media.user = extractUserShort(media.user)
  if (media.audio) media.audio_url = media.audio.audio_src
  return media
}

export const extractDirectMessage = (input) => {
  const data = clone(input)
  data.id = data.item_id
  if (data.media_share) {
    if (!data.media_share.code) data.media_share.code = InstagramIdCodec.encode(data.media_share.id)
    data.media_share = extractMediaV1(data.media_share)
  }
  if (data.media) data.media = extractDirectMedia(data.media)
  if (data.voice_media?.media) data.media = extractDirectMedia(data.voice_media.media)
  let clip = data.clip
  if (clip && Object.keys(clip).length) {
    if (clip.clip) clip = clip.clip
    data.clip = extractMediaV1(clip)
  }
  data.timestamp = microsecondsToDate(data.timestamp)
  data.user_id = String(data.user_id ?? '')
  data.client_context = data.client_context ?? ''
  for (const reaction of data.reactions?.emojis ?? []) {
    if (reaction.timestamp !== undefined) reaction.timestamp = microsecondsToDate(reaction.timestamp)
  }
  return data
}

export const extractDirectThread = (input) => {
  const data = clone(input)
  data.pk = data.thread_v2_id
  data.id = data.thread_id
  data.messages = (data.items ?? []).map((item) => {
    item.thread_id = data.id
    return extractDirectMessage(item)
  })
  data.users = (data.users ?? []).map(extractUserShort)
  data.inviter = data.inviter ? extractUserShort(data.inviter) : null
  data.left_users = (data.left_users ?? []).map(extractUserShort)
  data.is_close_friend_thread = data.is_close_friend_thread ?? false
  data.last_activity_at = microsecondsToDate(data.last_activity_at)
  for (const seen of Object.values(data.last_seen_at ?? {})) {
    if (seen.timestamp !== undefined) seen.timestamp = microsecondsToDate(seen.timestamp)
    if (seen.created_at !== undefined) seen.created_at = microsecondsToDate(seen.created_at)
  }
  return data
}

export const extractStoryV1 = (input) => {
  const story = clone(input)
  story.pk = String(story.pk)
  if (story.video_versions?.length) story.video_url = bestByArea(story.video_versions).url
  if (story.media_type === 2 && !story.product_type) story.product_type = 'story'
  if (story.image_versions2) story.thumbnail_url = bestByArea(story.image_versions2.candidates).url
  story.mentions = story.reel_mentions ?? []
  story.locations = story.story_locations ?? []
  story.hashtags = story.story_hashtags ?? []
  story.stickers = input.story_link_stickers ?? []
  story.polls = (story.story_polls ?? []).map((poll) => {
    const sticker = poll.poll_sticker ?? poll
    const options = (sticker.tallies ?? []).map((item) => item.text).filter((text) => text !== undefined)
    return {
      id: sticker.poll_id ?? sticker.id,
      type: poll.type ?? sticker.type ?? 'poll',
      x: poll.x ?? sticker.x ?? 0.5,
      y: poll.y ?? sticker.y ?? 0.5,
      z: poll.z ?? sticker.z ?? 0,
      width: poll.width ?? sticker.width ?? 0,
      height: poll.height ?? sticker.height ?? 0,
      rotation: poll.rotation ?? sticker.rotation ?? 0,
      is_multi_option: sticker.is_multi_option ?? sticker.is_multi_option_poll ?? true,
      is_shared_result: sticker.is_shared_result ?? false,
      viewer_can_vote: sticker.viewer_can_vote ?? true,
      finished: sticker.finished ?? false,
      color: sticker.color ?? 'black',
      poll_type: sticker.poll_type ?? '',
      question: sticker.question ?? '',
      options: options.length ? options : (sticker.options ?? []),
      extra: sticker
    }
  })
  story.medias = (input.story_feed_media ?? []).map((feedMedia) => ({
    ...feedMedia,
    media_pk: Number(feedMedia.media_id)
  }))
  story.links = []
  for (const sticker of story.story_link_stickers ?? []) {
    const url = sticker.story_link?.url
    if (url) story.links.push({ webUri: url })
  }
  for (const cta of story.story_cta ?? []) {
    for (const link of cta.links ?? []) story.links.push(link)
  }
  story.user = extractUserShort(story.user)
  story.sponsor_tags = (story.sponsor_tags ?? []).map((tag) => extractUserShort(tag.sponsor))
  if (!story.code) story.code = InstagramIdCodec.encode(story.pk)
  if (!story.taken_at) story.taken_at = story.device_timestamp ?? story.taken_at_timestamp
  return story
}
