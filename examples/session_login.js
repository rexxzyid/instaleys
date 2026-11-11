import { Client } from '../src/index.js'

const client = new Client()
await client.loginBySessionid(process.env.IG_SESSIONID)

const me = await client.accountInfo()
console.log(me.username)
