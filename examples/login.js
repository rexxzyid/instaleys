import { existsSync } from 'node:fs'
import { Client, LoginRequired } from '../src/index.js'

const SESSION_PATH = './session.json'
const { IG_USERNAME, IG_PASSWORD, IG_PROXY, IG_2FA } = process.env

const client = new Client({ proxy: IG_PROXY || null, delayRange: [1, 3] })

if (existsSync(SESSION_PATH)) {
  await client.loadSettings(SESSION_PATH)
}

try {
  await client.login(IG_USERNAME, IG_PASSWORD, { verificationCode: IG_2FA || '' })
} catch (error) {
  if (!(error instanceof LoginRequired)) throw error
  await client.login(IG_USERNAME, IG_PASSWORD, { relogin: true, verificationCode: IG_2FA || '' })
}

await client.dumpSettings(SESSION_PATH)

const me = await client.accountInfo()
console.log(`Login sebagai ${me.username} (${me.pk})`)
