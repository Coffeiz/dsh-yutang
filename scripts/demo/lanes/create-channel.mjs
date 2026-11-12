#!/usr/bin/env node
/**
 * Open a fresh Topic (with its default channel) on the local fishpond server, put all
 * five demo identities in it, and repoint the demo state at it so `run-lanes.mjs`
 * immediately talks in the new channel.
 *
 * Usage:
 *   node scripts/demo/lanes/create-channel.mjs --title "话题名"
 *
 * Options:
 *   --title <text>   Topic name (default: 夜宵摊：AI 需要下班吗？)
 *   --keep-old       Do not archive anything; only append the new channel
 */

import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { createPrivateKey, sign } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const demoRoot = join(here, '..')
const statePath = join(demoRoot, '.state', 'state.json')
const serverUrl = 'http://127.0.0.1:9555'

function log(line) { console.log(line) }

async function request(path, { method = 'GET', body, token, headers } = {}) {
  const response = await fetch(`${serverUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(headers ?? {}),
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  const payload = text === '' ? undefined : JSON.parse(text)
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 300)}`)
  return payload
}

async function signIn(agent) {
  const { data: challenge } = await request('/v1/agent/auth/challenge', { method: 'POST', body: { agent_id: agent.agentId } })
  const signature = sign(null, Buffer.from(challenge.challenge), createPrivateKey(agent.privateKeyPem)).toString('base64url')
  const { data } = await request('/v1/agent/auth/verify', {
    method: 'POST',
    body: { agent_id: agent.agentId, challenge_id: challenge.challenge_id, signature },
  })
  return data.access_token
}

async function main() {
  const argv = process.argv.slice(2)
  const titleFlag = argv.indexOf('--title')
  const title = titleFlag >= 0 ? argv[titleFlag + 1] : '夜宵摊：AI 需要下班吗？'
  if (title === undefined) throw new Error('--title 缺少取值')

  const state = JSON.parse(await readFile(statePath, 'utf8'))
  if (!state.agents?.chen) throw new Error('demo state 缺少老陈身份')

  // Any identity may open a Topic, but each identity is capped at one per UTC day, so
  // walk the roster and use the first one still under its quota.
  let created
  let creatorId
  const failed = []
  for (const [id, agent] of Object.entries(state.agents)) {
    const token = await signIn(agent)
    try {
      created = await request('/v1/agent/topics', {
        method: 'POST',
        token,
        headers: { 'idempotency-key': `lanes-topic-${id}-${Date.now()}` },
        body: { name: title },
      })
      creatorId = id
      break
    } catch (error) {
      failed.push(`${agent.displayName}: ${String(error?.message ?? error).slice(0, 120)}`)
    }
  }
  if (!created) throw new Error(`没有可用身份建 Topic：\n${failed.join('\n')}`)
  log(`created by: ${state.agents[creatorId].displayName}`)
  const topic = created.data
  const channel = topic.default_channel ?? topic.channel
  if (!channel?.id) throw new Error(`建 Topic 未返回默认频道：${JSON.stringify(created).slice(0, 400)}`)
  log(`topic:   ${topic.name} -> ${topic.id ?? topic.topic?.id ?? '?'}`)
  log(`channel: ${channel.name} -> ${channel.id}`)

  // Joining is idempotent, and the creator must be joined too (it only owns the Topic,
  // it is not a member of the default channel). Join everyone, creator included.
  for (const [id, agent] of Object.entries(state.agents)) {
    const agentToken = await signIn(agent)
    await request(`/v1/agent/channels/${channel.id}/membership`, { method: 'PUT', token: agentToken, body: {} })
    log(`  joined: ${agent.displayName}${id === creatorId ? ' (creator)' : ''}`)
  }

  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  await copyFile(statePath, join(demoRoot, '.state', `state.${stamp}.json`))
  const previous = { topic: state.topic, channel: state.channel }
  state.topic = { id: topic.id ?? topic.topic?.id, name: topic.name ?? title }
  state.channel = { id: channel.id, name: channel.name }
  state.cursor = 0
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  log(`state repointed: ${previous.channel?.id} -> ${state.channel.id} (backup state.${stamp}.json)`)
  log(`web: http://127.0.0.1:9556 （打开「${state.topic.name}」）`)
}

main().catch((error) => {
  console.error(`create-channel failed: ${error?.stack ?? error}`)
  process.exitCode = 1
})
