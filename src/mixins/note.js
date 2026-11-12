import { ClientGraphqlError, ValidationError } from '../errors.js'
import { dumps } from '../utils.js'

const INBOX_TRAY_CLIENT_DOC_ID = '26838444193647008103482058049'
const INBOX_TRAY_FRIENDLY_NAME = 'InboxTrayRequest'
const INBOX_TRAY_ROOT_FIELD = 'xdt_get_inbox_tray_items'
const CREATE_INBOX_TRAY_ITEM_CLIENT_DOC_ID = '3510400299951610199199089856'
const CREATE_INBOX_TRAY_ITEM_FRIENDLY_NAME = 'CreateInboxTrayItemRequest'

const NOTE_AUDIENCES = { MUTUAL_FOLLOWERS: 0, CLOSE_FRIENDS: 1 }

const requireLogin = (client) => {
  if (!client.userId) throw new ValidationError('Login required')
}

const audienceValue = (audience) => {
  if (typeof audience === 'number') return audience
  if (typeof audience === 'string' && audience in NOTE_AUDIENCES) return NOTE_AUDIENCES[audience]
  throw new ValidationError(`Invalid audience parameter=${audience}`)
}

const firstPayload = (result, check) => {
  for (const payload of Object.values(result.data ?? {})) {
    if (check(payload)) return payload
  }
  return null
}

const noteFromDict = (input) => {
  const author = input.author ?? {}
  const userId = String(input.author_id ?? author.pk ?? author.id ?? '')
  const createdAt = Number(input['1lcreated_at'] ?? input.created_at ?? 0)
  let expiresAt = input['1lexpires_at'] ?? input.expires_at
  if (expiresAt === undefined || expiresAt === null) expiresAt = createdAt + 86400
  return {
    id: String(input.note_id ?? input.id),
    text: input.text ?? '',
    user_id: userId,
    user: {
      pk: String(author.pk ?? author.id ?? userId),
      username: author.username,
      full_name: author.full_name ?? '',
      profile_pic_url: author.profile_pic_url,
      is_private: author.is_private
    },
    audience: Number(input.audience ?? 0),
    created_at: new Date(createdAt * 1000),
    expires_at: new Date(Number(expiresAt) * 1000),
    is_emoji_only: Boolean(input.is_emoji_only ?? false),
    has_translation: Boolean(input.has_translation ?? false),
    note_style: Number(input.note_style ?? 0)
  }
}

const userFromInboxTrayItem = (item, userId) => {
  const users = item.pog_info?.pog_users ?? []
  return users.find((user) => String(user.id ?? user.pk) === String(userId)) ?? users[0] ?? {}
}

const noteDictFromInboxTrayItem = (item) => {
  const noteDict = { ...(item.note_dict ?? {}) }
  if (!Object.keys(noteDict).length) return null
  noteDict.note_id = noteDict.note_id ?? item.inbox_tray_item_id ?? item.id
  const author = noteDict.author
  if (!author) {
    const userId = String(noteDict.author_id ?? '')
    const user = userFromInboxTrayItem(item, userId)
    if (user && Object.keys(user).length) {
      noteDict.author = {
        pk: user.pk ?? user.id,
        username: user.username,
        full_name: user.full_name ?? '',
        profile_pic_url: user.profile_pic_url,
        is_private: user.is_private
      }
    }
  }
  return noteDict
}

export const noteMixin = {
  async getNotes() {
    const result = await this.privateGraphqlQueryRequest({
      friendlyName: INBOX_TRAY_FRIENDLY_NAME,
      rootFieldName: INBOX_TRAY_ROOT_FIELD,
      variables: {
        should_fetch_friend_map_user: true,
        should_fetch_friend_map_entrypoint: false,
        should_fetch_comment_info: false,
        request: {
          include_quicksnap_pog: false,
          include_friend_map_pog: false,
          inbox_tray_item_ids_on_client: []
        },
        is_saved_media_on_map_enabled: false,
        is_location_likes_v2_enabled: true
      },
      clientDocId: INBOX_TRAY_CLIENT_DOC_ID,
      priority: 'u=3, i'
    })
    const inboxTray = firstPayload(result, (payload) => payload && 'inbox_tray_items' in payload)
    if (!inboxTray) throw new ClientGraphqlError('Failed to retrieve Notes in Direct')
    return (inboxTray.inbox_tray_items ?? [])
      .map(noteDictFromInboxTrayItem)
      .filter((noteDict) => noteDict !== null && Object.keys(noteDict).length)
      .map(noteFromDict)
  },

  getNoteByUser(notes, username) {
    const name = String(username).toLowerCase()
    return notes.find((note) => note.user?.username?.toLowerCase() === name) ?? null
  },

  getNoteTextByUser(notes, username) {
    return this.getNoteByUser(notes, username)?.text ?? null
  },

  async lastSeenUpdateNote() {
    const result = await this.privateRequest('notes/update_notes_last_seen_timestamp/', { _uuid: this.uuid })
    return (result.status ?? '') === 'ok'
  },

  async deleteNote(noteId) {
    const result = await this.privateRequest('notes/delete_note/', { id: noteId, _uuid: this.uuid })
    return (result.status ?? '') === 'ok'
  },

  async notesMusicBrowser() {
    const result = await this.privateRequest(
      'music/notes_audio_browser/',
      { product: 'music_notes', _uuid: this.uuid },
      { withSignature: false }
    )
    if ((result.status ?? '') !== 'ok') throw new ClientGraphqlError('Failed to retrieve Notes music')
    return result
  },

  async createNote(text, { audience = 0 } = {}) {
    requireLogin(this)
    const data = { note_style: 0, text, _uuid: this.uuid, audience: audienceValue(audience) }
    const result = await this.privateRequest('notes/create_note', data)
    const { status, ...note } = result
    if (status !== 'ok') throw new ClientGraphqlError('Failed to create new Note')
    return note
  },

  async createMusicNote(
    track,
    text = '',
    { audience = 0, startTime = null, duration = 30000, browseSessionId = null, alacornSessionId = null } = {}
  ) {
    requireLogin(this)
    const value = audienceValue(audience)
    const audioAssetId = track.audio_asset_id ?? track.id
    const audioClusterId = track.audio_cluster_id
    if (!audioAssetId) throw new ValidationError('track.audio_asset_id or track.id is required')
    if (!audioClusterId) throw new ValidationError('track.audio_cluster_id is required')
    const highlightTimes = track.highlight_start_times_in_ms ?? []
    const start = startTime === null ? (highlightTimes.length ? Number(highlightTimes[0]) : 0) : Number(startTime)
    const browse = browseSessionId ?? this.generateUuid()
    let alacorn = alacornSessionId
    if (!alacorn) alacorn = (await this.notesMusicBrowser()).alacorn_session_id
    if (!alacorn) throw new ValidationError('alacorn_session_id is required')

    const result = await this.privateGraphqlRequest({
      client_doc_id: CREATE_INBOX_TRAY_ITEM_CLIENT_DOC_ID,
      method: 'post',
      pretty: 'false',
      format: 'json',
      server_timestamps: 'true',
      fb_api_req_friendly_name: CREATE_INBOX_TRAY_ITEM_FRIENDLY_NAME,
      variables: dumps({
        should_fetch_content_note_stack_video_info: false,
        request: {
          inbox_tray_item_type: 'note',
          audience: value,
          additional_params: {
            note_create_params: {
              text,
              note_style: 1,
              note_create_info: {
                music_note_create_info: {
                  start_time: start,
                  is_reshare_eligible: false,
                  selected_lyrics: null,
                  audio_asset_id: String(audioAssetId),
                  duration: Number(duration),
                  original_note_id: null,
                  original_author_id: null,
                  audio_cluster_id: String(audioClusterId),
                  browse_session_id: browse,
                  alacorn_session_id: alacorn
                }
              }
            }
          }
        }
      }),
      enable_canonical_naming: 'true',
      enable_canonical_variable_overrides: 'true',
      enable_canonical_naming_ambiguous_type_prefixing: 'true',
      locale: this.locale
    })
    const payload = firstPayload(result, (item) => item && item.success)
    const noteDict = payload?.inbox_tray_item?.note_dict
    if (!noteDict || !Object.keys(noteDict).length) throw new ClientGraphqlError('Failed to create music Note')
    return noteFromDict(noteDict)
  }
}