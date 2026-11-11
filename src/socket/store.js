import { readFile, writeFile } from 'node:fs/promises'
import { jidDecode } from './jid.js'

class KeyedStore {
  constructor({ sort = null } = {}) {
    this.map = new Map()
    this.sort = sort
  }

  get length() {
    return this.map.size
  }

  get(id) {
    return this.map.get(id)
  }

  insertIfAbsent(...items) {
    let inserted = 0
    for (const item of items) {
      if (this.map.has(item.id)) continue
      this.map.set(item.id, item)
      inserted += 1
    }
    return inserted
  }

  upsert(...items) {
    for (const item of items) {
      const existing = this.map.get(item.id)
      this.map.set(item.id, existing ? Object.assign(existing, item) : item)
    }
  }

  update(id, mutator) {
    const item = this.map.get(id)
    if (!item) return false
    mutator(item)
    return true
  }

  updateAssign(id, update) {
    const item = this.map.get(id)
    if (!item) return false
    Object.assign(item, update)
    return true
  }

  deleteById(id) {
    return this.map.delete(id)
  }

  clear() {
    this.map.clear()
  }

  all() {
    const items = [...this.map.values()]
    return this.sort ? items.sort(this.sort) : items
  }

  toJSON() {
    return this.all()
  }

  fromJSON(items) {
    this.map.clear()
    for (const item of items) this.map.set(item.id, item)
  }
}

class MessageList {
  constructor(max = 0) {
    this.array = []
    this.map = new Map()
    this.max = max
  }

  get(id) {
    return this.map.get(id)
  }

  all() {
    return this.array
  }

  upsert(message, mode = 'append') {
    const id = message.key.id
    const existing = this.map.get(id)
    if (existing) {
      Object.assign(existing, message)
      return existing
    }
    this.map.set(id, message)
    if (mode === 'prepend') {
      this.array.unshift(message)
    } else if (!this.array.length || message.messageTimestamp >= this.array.at(-1).messageTimestamp) {
      this.array.push(message)
    } else {
      let index = this.array.length
      while (index > 0 && this.array[index - 1].messageTimestamp > message.messageTimestamp) index -= 1
      this.array.splice(index, 0, message)
    }
    if (this.max && this.array.length > this.max) {
      const removed = this.array.splice(0, this.array.length - this.max)
      for (const old of removed) this.map.delete(old.key.id)
    }
    return message
  }

  updateAssign(id, update) {
    const message = this.map.get(id)
    if (!message) return false
    Object.assign(message, update)
    return true
  }

  remove(id) {
    const message = this.map.get(id)
    if (!message) return false
    this.map.delete(id)
    this.array.splice(this.array.indexOf(message), 1)
    return true
  }

  clear() {
    this.array.length = 0
    this.map.clear()
  }

  filter(predicate) {
    this.array = this.array.filter(predicate)
    this.map = new Map(this.array.map((message) => [message.key.id, message]))
  }

  toJSON() {
    return this.array
  }

  fromJSON(items) {
    this.clear()
    for (const item of items) this.upsert(item)
  }
}

const sameKeyUser = (a, b) => (a ?? '') === (b ?? '')

export const makeInMemoryStore = ({ logger = null, maxMessagesPerChat = 0 } = {}) => {
  const chats = new KeyedStore({ sort: (a, b) => (b.conversationTimestamp ?? 0) - (a.conversationTimestamp ?? 0) })
  const contacts = {}
  const messages = {}
  const groupMetadata = {}
  const presences = {}
  const state = { connection: 'close' }

  const listFor = (jid) => (messages[jid] ??= new MessageList(maxMessagesPerChat))

  const touchChat = (jid, timestamp) => {
    if (!chats.get(jid)) chats.insertIfAbsent({ id: jid, conversationTimestamp: timestamp ?? 0, unreadCount: 0 })
    else if (timestamp && timestamp > (chats.get(jid).conversationTimestamp ?? 0)) {
      chats.updateAssign(jid, { conversationTimestamp: timestamp })
    }
  }

  const upsertContact = (contact) => {
    contacts[contact.id] = Object.assign(contacts[contact.id] ?? {}, contact)
  }

  const bind = (ev) => {
    ev.on('connection.update', (update) => Object.assign(state, update))

    ev.on('messaging-history.set', ({ chats: newChats = [], contacts: newContacts = [], messages: newMessages = [], isLatest }) => {
      if (isLatest) {
        chats.clear()
        for (const jid of Object.keys(messages)) delete messages[jid]
      }
      chats.upsert(...newChats)
      for (const contact of newContacts) upsertContact(contact)
      for (const message of newMessages) listFor(message.key.remoteJid).upsert(message, 'append')
    })

    ev.on('chats.upsert', (list) => chats.upsert(...list))
    ev.on('chats.update', (list) => {
      for (const update of list) {
        if (!chats.updateAssign(update.id, update)) chats.insertIfAbsent({ ...update })
      }
    })
    ev.on('chats.delete', (ids) => {
      for (const id of ids) {
        chats.deleteById(id)
        delete messages[id]
      }
    })

    ev.on('contacts.upsert', (list) => list.forEach(upsertContact))
    ev.on('contacts.update', (list) => {
      for (const update of list) if (update.id) upsertContact(update)
    })

    ev.on('messages.upsert', ({ messages: incoming, type }) => {
      for (const message of incoming) {
        const jid = message.key.remoteJid
        listFor(jid).upsert(message, 'append')
        touchChat(jid, message.messageTimestamp)
        if (type === 'notify' && !message.key.fromMe && message.message) {
          chats.update(jid, (chat) => {
            chat.unreadCount = (chat.unreadCount ?? 0) + 1
          })
        }
      }
    })

    ev.on('messages.update', (updates) => {
      for (const { key, update } of updates) listFor(key.remoteJid).updateAssign(key.id, update)
    })

    ev.on('messages.delete', (item) => {
      if (item.all) {
        listFor(item.jid).clear()
        return
      }
      for (const key of item.keys) listFor(key.remoteJid).remove(key.id)
    })

    ev.on('messages.reaction', (items) => {
      for (const { key, reaction } of items) {
        const message = listFor(key.remoteJid).get(key.id)
        if (!message) continue
        const reactions = (message.reactions ?? []).filter(
          (existing) => !sameKeyUser(existing.key.participant, reaction.key.participant)
        )
        if (reaction.text) reactions.push(reaction)
        message.reactions = reactions
      }
    })

    ev.on('message-receipt.update', (items) => {
      for (const { key, receipt } of items) {
        const message = listFor(key.remoteJid).get(key.id)
        if (!message) continue
        message.userReceipt = [...(message.userReceipt ?? []).filter((item) => item.userJid !== receipt.userJid), receipt]
        if (receipt.readTimestamp) message.status = 'READ'
      }
    })

    ev.on('groups.upsert', (list) => {
      for (const group of list) groupMetadata[group.id] = Object.assign(groupMetadata[group.id] ?? {}, group)
    })
    ev.on('groups.update', (list) => {
      for (const group of list) {
        if (groupMetadata[group.id]) Object.assign(groupMetadata[group.id], group)
      }
    })
    ev.on('group-participants.update', ({ id, participants, action }) => {
      const group = groupMetadata[id]
      if (!group) return
      if (action === 'add') {
        for (const participant of participants) {
          if (!group.participants.some((item) => item.id === participant)) group.participants.push({ id: participant })
        }
      } else if (action === 'remove') {
        group.participants = group.participants.filter((item) => !participants.includes(item.id))
      } else {
        for (const item of group.participants) {
          if (participants.includes(item.id)) item.admin = action === 'promote' ? 'admin' : null
        }
      }
    })

    ev.on('presence.update', ({ id, presences: update }) => {
      presences[id] = Object.assign(presences[id] ?? {}, update)
    })
  }

  const loadMessages = async (jid, count, cursor = null) => {
    const list = listFor(jid).array
    let end = list.length
    if (cursor?.before) {
      const index = list.findIndex((message) => message.key.id === cursor.before.id)
      if (index >= 0) end = index
    }
    return list.slice(Math.max(0, end - count), end)
  }

  const toJSON = () => ({
    chats: chats.toJSON(),
    contacts,
    messages: Object.fromEntries(Object.entries(messages).map(([jid, list]) => [jid, list.toJSON()])),
    groupMetadata
  })

  const fromJSON = (json) => {
    chats.fromJSON(json.chats ?? [])
    for (const key of Object.keys(contacts)) delete contacts[key]
    Object.assign(contacts, json.contacts ?? {})
    for (const key of Object.keys(messages)) delete messages[key]
    for (const [jid, items] of Object.entries(json.messages ?? {})) listFor(jid).fromJSON(items)
    for (const key of Object.keys(groupMetadata)) delete groupMetadata[key]
    Object.assign(groupMetadata, json.groupMetadata ?? {})
  }

  return {
    chats,
    contacts,
    messages,
    groupMetadata,
    presences,
    state,
    bind,
    toJSON,
    fromJSON,
    loadMessages,
    loadMessage: async (jid, id) => listFor(jid).get(id),
    mostRecentMessage: async (jid) => listFor(jid).array.at(-1),
    getChat: (jid) => chats.get(jid),
    fetchImageUrl: async (jid, sock) => {
      const contact = contacts[jid]
      if (contact && contact.imgUrl === undefined) contact.imgUrl = await sock.profilePictureUrl(jid).catch(() => null)
      return contact?.imgUrl
    },
    fetchGroupMetadata: async (jid, sock) => {
      if (!groupMetadata[jid]) groupMetadata[jid] = await sock.groupMetadata(jid)
      return groupMetadata[jid]
    },
    loadMessagesFromSock: async (sock, jid, count) => {
      const history = await sock.fetchMessageHistory(jid, count)
      for (const message of history) listFor(jid).upsert(message, 'append')
      return listFor(jid).array.slice(-count)
    },
    writeToFile: async (path) => {
      await writeFile(path, JSON.stringify(toJSON()))
      logger?.debug?.({ path }, 'store written')
    },
    readFromFile: async (path) => {
      try {
        fromJSON(JSON.parse(await readFile(path, 'utf8')))
        return true
      } catch (error) {
        if (error?.code === 'ENOENT') return false
        throw error
      }
    },
    isGroup: (jid) => jidDecode(jid)?.server === 'g.instagram.net'
  }
}
