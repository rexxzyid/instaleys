import { Client } from '../src/index.js'

const client = new Client()
await client.loadSettings('./session.json')

const target = await client.userInfoByUsername(process.env.IG_TARGET)
const message = await client.directSend('Halo dari Node.js', { userIds: [target.pk] })
console.log(message.id, message.thread_id)

const threads = await client.directThreads(5)
for (const thread of threads) {
  console.log(thread.id, thread.users.map((u) => u.username).join(', '))
}

const messages = await client.directMessages(message.thread_id, 10)
console.log(messages.map((m) => m.text))
