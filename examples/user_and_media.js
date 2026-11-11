import { Client } from '../src/index.js'

const client = new Client()
await client.loadSettings('./session.json')

const user = await client.userInfoByUsername('instagram')
console.log(user.username, user.follower_count, user.media_count)

const medias = await client.userMedias(user.pk, 5)
for (const media of medias) {
  console.log(media.code, media.like_count, media.caption_text.slice(0, 60))
}

const followers = await client.userFollowers(user.pk, { amount: 20 })
console.log(Object.keys(followers).length)

for await (const following of client.iterUserFollowingV1(user.pk, { amount: 50, pageSize: 25 })) {
  console.log(following.username)
}
