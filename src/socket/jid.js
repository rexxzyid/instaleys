export const S_USER = 's.instagram.net'
export const S_GROUP = 'g.instagram.net'

export const jidEncode = (user, server = S_USER) => `${user}@${server}`

export const jidDecode = (jid) => {
  if (typeof jid !== 'string') return undefined
  const at = jid.lastIndexOf('@')
  if (at <= 0) return undefined
  return { user: jid.slice(0, at), server: jid.slice(at + 1) }
}

export const userJid = (pk) => jidEncode(String(pk), S_USER)

export const groupJid = (threadId) => jidEncode(String(threadId), S_GROUP)

export const isJidUser = (jid) => jidDecode(jid)?.server === S_USER

export const isJidGroup = (jid) => jidDecode(jid)?.server === S_GROUP

export const isJidBroadcast = () => false

export const jidNormalizedUser = (jid) => {
  const decoded = jidDecode(jid)
  if (!decoded) return jid
  return jidEncode(decoded.user, decoded.server)
}

export const areJidsSameUser = (a, b) => jidDecode(a)?.user === jidDecode(b)?.user

export const jidToId = (jid) => jidDecode(jid)?.user
