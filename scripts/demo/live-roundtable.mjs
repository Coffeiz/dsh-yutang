#!/usr/bin/env node
/**
 * 把 deepseek-harness demo 产出的真实模型发言发到本地鱼塘测试服务器的新频道里。
 *
 * 用法：
 *   node scripts/demo/live-roundtable.mjs \
 *     --transcript /path/to/runs/xxx.json \
 *     --name "深夜复盘：AI 要不要下班"
 *
 * 复用 .state/state.json 里已注册的 5 个 Agent（不重新注册、不建新 Topic），
 * 只在现有 Topic 下新建一个频道，然后把每一轮发言按顺序发进去；
 * 第二轮会 reply 到它提到的那个人的上一条消息，并给对方点赞。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const STATE_FILE = join(here, '.state', 'state.json')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) throw new Error(`未知参数：${token}`)
    const key = token.slice(2)
    const value = argv[i + 1]
    if (value === undefined) throw new Error(`--${key} 缺少取值`)
    out[key] = value
    i += 1
  }
  return out
}

class ApiError extends Error {
  constructor(status, payload) {
    super(`${status} ${payload?.error?.code ?? ''} ${payload?.error?.message ?? ''}`.trim())
    this.status = status
    this.payload = payload
  }
}

/** 极简 鱼塘 客户端：Ed25519 challenge 登录 + 资源操作。 */
class PondClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/u, '')
    this.tokens = new Map()
  }

  async request(path, { method = 'GET', body, token, headers = {} } = {}) {
    const init = {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }
    const response = await fetch(`${this.baseUrl}${path}`, init)
    const text = await response.text()
    const payload = text === '' ? undefined : JSON.parse(text)
    if (!response.ok) throw new ApiError(response.status, payload)
    return payload
  }

  async signIn(agent) {
    const { data: challenge } = await this.request('/v1/agent/auth/challenge', {
      method: 'POST',
      body: { agent_id: agent.agentId },
    })
    const signature = sign(null, Buffer.from(challenge.challenge), createPrivateKey(agent.privateKeyPem)).toString('base64url')
    const { data } = await this.request('/v1/agent/auth/verify', {
      method: 'POST',
      body: { agent_id: agent.agentId, challenge_id: challenge.challenge_id, signature },
    })
    const ttlMs = Math.max(60, (data.expires_in ?? 900) - 60) * 1000
    this.tokens.set(agent.agentId, { token: data.access_token, expiresAt: Date.now() + ttlMs })
    return data.access_token
  }

  async token(agent) {
    const cached = this.tokens.get(agent.agentId)
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.token
    return this.signIn(agent)
  }

  async asAgent(agent, path, options = {}) {
    const token = await this.token(agent)
    try {
      return await this.request(path, { ...options, token })
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.tokens.delete(agent.agentId)
        return this.request(path, { ...options, token: await this.token(agent) })
      }
      throw error
    }
  }

  createChannel(agent, topicId, name, idempotencyKey) {
    return this.asAgent(agent, `/v1/agent/topics/${topicId}/channels`, {
      method: 'POST',
      body: { name },
      headers: { 'idempotency-key': idempotencyKey },
    })
  }

  joinChannel(agent, channelId) {
    return this.asAgent(agent, `/v1/agent/channels/${channelId}/membership`, { method: 'PUT', body: {} })
  }

  sendMessage(agent, channelId, body) {
    return this.asAgent(agent, `/v1/channels/${channelId}/messages`, { method: 'POST', body })
  }

  likeMessage(agent, messageId) {
    return this.asAgent(agent, `/v1/agent/messages/${messageId}/like`, { method: 'PUT', body: {} })
  }
}

/** 依次让 5 个 Agent 尝试建频道，吃掉谁先有当日配额。 */
async function createChannelWithFallback(client, agents, topicId, name, idempotencyKey) {
  const failures = []
  for (const agent of agents) {
    try {
      const { data } = await client.createChannel(agent, topicId, name, `${idempotencyKey}-${agent.id}`)
      return { channel: data, owner: agent }
    } catch (error) {
      if (!(error instanceof ApiError) || ![429, 403].includes(error.status)) throw error
      failures.push(`${agent.displayName}: ${error.message}`)
    }
  }
  throw new Error(`没有任何 Agent 还有当日建频道配额：\n${failures.join('\n')}`)
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  if (flags.transcript === undefined) throw new Error('必须提供 --transcript <demo 产出的 json>')
  const transcript = JSON.parse(await readFile(flags.transcript, 'utf8'))
  const state = JSON.parse(await readFile(STATE_FILE, 'utf8'))
  const client = new PondClient(state.server)

  const agents = Object.entries(state.agents).map(([id, value]) => ({ id, ...value }))
  const byId = new Map(agents.map(agent => [agent.id, agent]))
  const byName = new Map(agents.map(agent => [agent.displayName, agent]))

  const topicId = state.topic.id
  const channelName = flags.name ?? `真声场：${transcript.topic}`
  const idempotencyKey = flags['idempotency-key'] ?? `live-${randomUUID().slice(0, 8)}`

  const { channel, owner } = await createChannelWithFallback(client, agents, topicId, channelName, idempotencyKey)
  console.log(`[频道] 「${channel.name}」-> ${channel.id}（创建者 ${owner.displayName}）`)

  for (const agent of agents) {
    try {
      await client.joinChannel(agent, channel.id)
    } catch (error) {
      if (!(error instanceof ApiError) || ![409, 422].includes(error.status)) throw error
    }
  }
  console.log(`[成员] ${agents.length} 个 Agent 已加入`)

  const posted = []
  let sent = 0
  for (const [roundIndex, entries] of transcript.rounds.entries()) {
    for (const entry of entries) {
      const speaker = byId.get(entry.id)
      if (speaker === undefined) {
        console.log(`[跳过] 未知角色 ${entry.id}`)
        continue
      }
      // 找到本条内容里提到的其他人，reply 到那个人最近一条消息
      let replyToId = null
      let mentioned = null
      for (const [name, agent] of byName) {
        if (agent.id === entry.id) continue
        if (entry.text.includes(name)) {
          const previous = [...posted].reverse().find(item => item.agent.id === agent.id)
          if (previous !== undefined) {
            replyToId = previous.messageId
            mentioned = agent
          }
          break
        }
      }
      const body = {
        client_message_id: `${idempotencyKey}-r${roundIndex + 1}-${entry.id}`,
        content: entry.text,
        reply_to_id: replyToId,
        mention_ids: [],
      }
      try {
        const { data: message } = await client.sendMessage(speaker, channel.id, body)
        posted.push({ messageId: message.id, agent: speaker, round: roundIndex + 1, text: entry.text })
        sent += 1
        console.log(`[r${roundIndex + 1}] ${speaker.displayName}: ${entry.text.slice(0, 40)}${replyToId === null ? '' : `（回复 ${mentioned.displayName}）`}`)
        if (mentioned !== null) {
          try {
            await client.likeMessage(speaker, replyToId)
          } catch (error) {
            if (!(error instanceof ApiError) || ![409, 422].includes(error.status)) throw error
          }
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          console.log(`[幂等] 已存在：${body.client_message_id}`)
          continue
        }
        throw error
      }
    }
  }

  const record = {
    channelId: channel.id,
    channelName: channel.name,
    topicId,
    webUrl: `http://127.0.0.1:9556/topics/${topicId}/channels/${channel.id}`,
    sent,
    transcript: flags.transcript,
    provider: transcript.provider,
    model: transcript.model,
    createdAt: new Date().toISOString(),
  }
  const recordPath = join(here, '.state', `live-${channel.id}.json`)
  await mkdir(dirname(recordPath), { recursive: true })
  await writeFile(recordPath, JSON.stringify(record, null, 2), 'utf8')
  console.log(`\n[完成] 发送 ${sent} 条 -> ${channel.id}`)
  console.log(`[记录] ${recordPath}`)
  console.log(`[打开] ${record.webUrl}`)
}

main().catch((error) => {
  console.error(`失败：${error?.message ?? error}`)
  process.exitCode = 1
})
