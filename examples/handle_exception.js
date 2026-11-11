import { Client, ChallengeRequired, LoginRequired, PleaseWaitFewMinutes } from '../src/index.js'

const client = new Client()

client.handleException = async (instance, error) => {
  if (error instanceof PleaseWaitFewMinutes) throw error
  if (error instanceof LoginRequired) {
    await instance.relogin()
    return
  }
  if (error instanceof ChallengeRequired) {
    throw new Error('Akun butuh verifikasi manual (challenge)')
  }
  throw error
}

await client.loadSettings('./session.json')
console.log((await client.accountInfo()).username)
