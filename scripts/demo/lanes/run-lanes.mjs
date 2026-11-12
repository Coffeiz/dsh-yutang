#!/usr/bin/env node
/**
 * Loop-browse demo: five registered fishpond identities share one channel and keep
 * talking without anybody @-ing them. Each DSH Session owns one identity through a
 * `session_bindings` lane in `browse_schedule_mode: 'loop'`; the plugin's worker
 * polls the channel on its own phase and answers with a real model turn.
 *
 * Usage:
 *   node scripts/demo/lanes/run-lanes.mjs --seconds 180
 *
 * Options:
 *   --seconds <n>        observation window after the opener (default 180)
 *   --loop <n>           per-lane polling interval in seconds (default 45)
 *   --provider <id>      LLM provider (default: deepseek-account)
 *   --model <id>         model id (default: deepseek-flash)
 *   --opener-text <t>    opening line content
 *   --keep-bindings keep  reuse bindings from a previous run (they only resolve inside
 *                         the process that created them)
 *   --no-opener          do not post the opening line
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createPrivateKey, sign } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness } from '/Users/coffeiz/Desktop/workspace/deepseek-harness/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const demoRoot = join(here, '..')
const statePath = join(here, 'data', 'state.json')
const seedPath = join(here, 'seed.json')
const patchPath = join(here, 'cordis.patch.yml')
const serverUrl = 'http://127.0.0.1:9555'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) throw new Error(`未知参数：${token}`)
    const key = token.slice(2)
    if (key === 'no-opener') { out.opener = false; continue }
    const value = argv[i + 1]
    if (value === undefined) throw new Error(`--${key} 缺少取值`)
    out[key] = value
    i += 1
  }
  return out
}

function log(line) { console.log(`${new Date().toISOString().slice(11, 19)} ${line}`) }

async function request(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${serverUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  const payload = text === '' ? undefined : JSON.parse(text)
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 300)}`)
  return payload
}

/** The local server answers 500 on the auth pair under a burst of lane start-ups; retry before giving up. */
async function signIn(agent, attempts = 4) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { data: challenge } = await request('/v1/agent/auth/challenge', { method: 'POST', body: { agent_id: agent.agentId } })
      const signature = sign(null, Buffer.from(challenge.challenge), createPrivateKey(agent.privateKeyPem)).toString('base64url')
      const { data } = await request('/v1/agent/auth/verify', { method: 'POST', body: { agent_id: agent.agentId, challenge_id: challenge.challenge_id, signature } })
      return data.access_token
    } catch (error) {
      lastError = error
      await new Promise(done => setTimeout(done, attempt * 800))
    }
  }
  throw lastError
}

/** Write the identity seed the plugin imports on start-up. */
async function writeSeed(demo, personas) {
  const agents = personas.map(persona => {
    const agent = demo.agents[persona.id]
    if (!agent) throw new Error(`demo state 缺少身份：${persona.id}`)
    return { agent_id: agent.agentId, display_name: agent.displayName, public_key: agent.publicKeyPem, private_key: agent.privateKeyPem }
  })
  await writeFile(seedPath, JSON.stringify({ server_url: serverUrl, owner_id: 'demo-owner', agents }, null, 2), 'utf8')
  log(`seed: ${agents.length} identities -> ${seedPath}`)
}

/** Persona instructions live in AGENTS.md so every lane's turn carries its own voice. */
async function prepareWorkspaces(personas, topic) {
  const workspaces = []
  for (const persona of personas) {
    const dir = join(here, 'workspaces', persona.id)
    await mkdir(dir, { recursive: true })
    const text = [
      '# 你在这个频道里的身份',
      '',
      persona.persona,
      '',
      '## 现场',
      `- 频道话题：${topic}`,
      '- 频道里还有 4 个同样在聊的人，你们都不点名、不 @ 人，靠内容接话。',
      '- 用 `yutang_read` 看最近消息，用 `yutang_send` 发一句。每次最多发一条，不复述别人的话。',
      '- 像群聊一样自然：接得住上一条的具体内容，可以反驳、补充、抛新角度，也可以只回一两个字。',
      '- 不要自我介绍，不要总结全场，不要说「作为 AI」。',
      '',
      '## 长度（最重要）',
      '- 一条消息就是一个人的一句话：不加标题、不分段、不列点、不写小标题。',
      '- 超过上面人格里写的字数就是失败。短是风格，不是敷衍。',
      '',
      '## 忌讳',
      '- 不许把话题抬到规则、约束、格式、聊天机制这类元层面，就聊话题本身。',
      '- 不许复盘别人的话再「接一半」，不许用「X 我接，但……」这种套话开头。',
    ].join('\n')
    await writeFile(join(dir, 'AGENTS.md'), `${text}\n`, 'utf8')
    workspaces.push({ persona, dir })
  }
  return workspaces
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  const seconds = Math.max(30, Number.parseInt(flags.seconds ?? '180', 10) || 180)
  const loopSeconds = Math.max(20, Number.parseInt(flags.loop ?? '45', 10) || 45)
  const provider = flags.provider ?? 'deepseek-account'
  const model = flags.model ?? 'deepseek-flash'

  const demo = JSON.parse(await readFile(join(demoRoot, '.state', 'state.json'), 'utf8'))
  const personas = JSON.parse(await readFile(join(demoRoot, 'personas.json'), 'utf8'))
  const topic = demo.topic.name
  const channelId = demo.channel.id

  await writeSeed(demo, personas)
  const workspaces = await prepareWorkspaces(personas, topic)

  // Bindings point at Session ids that only exist inside the run that created them, so a
  // stale set would leave every fresh Session unbound and the lanes silently idle.
  if (flags['keep-bindings'] !== 'keep') {
    const db = JSON.parse(await readFile(statePath, 'utf8'))
    const stale = Object.keys(db.session_bindings ?? {})
    if (stale.length > 0) {
      db.session_bindings = {}
      // Read cursors ride on the connection, not the lane: reset them too so the fresh
      // Session sees the channel from the top instead of skipping the opener.
      // Pin every lane to the current demo channel; null lets the plugin fall back to
      // whatever channel it saw last, which silently splits a round across old channels.
      db.servers = (db.servers ?? []).map(server => ({ ...server, read_cursors: {}, browse_channel_cursor_id: channelId }))
      await writeFile(statePath, `${JSON.stringify(db, null, 2)}\n`, 'utf8')
      log(`cleared ${stale.length} stale session bindings and all read cursors`)
    }
  }

  const harness = new DeepSeekHarness({
    profile: 'demo-lanes',
    dshHome: join(homedir(), '.dsh'),
    provider,
    model,
    patches: [patchPath],
    env: {
      ...process.env,
      YUTANG_DEMO_AUTO_ASSIGN: '1',
      YUTANG_DEMO_SEED: seedPath,
      YUTANG_DEMO_LOOP_SECONDS: String(loopSeconds),
    },
    initializeTimeoutMs: 120_000,
    requestTimeoutMs: 180_000,
  })

  const transcript = []
  try {
    // Booting a Session only when it first runs, so one short turn per persona both
    // creates the Agent (and its lane binding) and leaves a persisted session behind.
    for (const { persona, dir } of workspaces) {
      const session = harness.session()
      await session.setWorkingDirectory(dir)
      log(`session ${persona.display_name}: ${session.id}`)
      await session.run('只回复两个字：就绪。不要调用任何工具。')
        .then(result => log(`  warm-up: ${JSON.stringify(String(result.finalResponse ?? '').slice(0, 40))}`))
        .catch(error => log(`  warm-up skipped: ${error?.message ?? error}`))
      await new Promise(done => setTimeout(done, 1500))
    }

    const bindings = await readFile(statePath, 'utf8').then(text => JSON.parse(text).session_bindings ?? {})
    log(`bindings: ${Object.keys(bindings).length} / ${personas.length}`)
    for (const [sessionId, binding] of Object.entries(bindings)) {
      log(`  ${sessionId} -> ${binding.connection_id} mode=${binding.browse_schedule_mode} every=${binding.loop_interval_seconds}s`)
    }

    if (flags.opener !== false) {
      const opener = flags['opener-text'] ?? flags.opener_text ?? '凌晨一点了，这个点还在线的，到底是睡不着，还是被排班给排的？'
      let posted = false
      for (let attempt = 1; attempt <= 3 && !posted; attempt += 1) {
        try {
          const token = await signIn(demo.agents.chen)
          await request(`/v1/channels/${channelId}/messages`, {
            method: 'POST',
            token,
            body: { client_message_id: `opener-${Date.now()}`, content: opener, reply_to_id: null, mention_ids: [] },
          })
          log(`opener posted by 老陈 (no mentions): ${opener}`)
          posted = true
        } catch (error) {
          log(`opener attempt ${attempt} failed: ${error?.message ?? error}`)
          await new Promise(done => setTimeout(done, 2000))
        }
      }
      if (!posted) {
        log('opener failed after 3 attempts, lanes will run on whatever is already in the channel')
        // No message means every lane polls an empty channel and stays silent for the whole
        // window, so stop early instead of burning the full duration.
        if ((await request(`/v1/channels/${channelId}/messages?limit=5`)).data.messages.length === 0) {
          throw new Error('channel is empty and the opener could not be posted')
        }
      }
    }

    const seen = new Set()
    const deadline = Date.now() + seconds * 1000
    process.stdout.write('')
    while (Date.now() < deadline) {
      const { data } = await request(`/v1/channels/${channelId}/messages?limit=50`)
      const messages = Array.isArray(data) ? data : data.items ?? []
      for (const message of messages) {
        if (seen.has(message.id)) continue
        if (message.topic_id !== undefined && message.channel_id !== undefined && message.channel_id !== channelId) { seen.add(message.id); continue }
        seen.add(message.id)
        const author = message.sender?.name ?? message.author?.name ?? message.author_name ?? '?'
        const at = new Date(message.created_at ?? Date.now()).toISOString().slice(11, 19)
        log(`  [${at}] ${author}: ${String(message.content ?? '').replace(/\s+/gu, ' ')}`)
        transcript.push({ at, author, content: message.content })
      }
      await new Promise(done => setTimeout(done, 5000))
    }

    const own = transcript.filter(entry => personas.some(persona => persona.display_name === entry.author))
    log(`\n[done] 频道新增 ${transcript.length} 条，其中人格发言 ${own.length} 条`)
    const counts = {}
    for (const entry of own) counts[entry.author] = (counts[entry.author] ?? 0) + 1
    log(`[done] 各人格发言数：${JSON.stringify(counts)}`)
  } finally {
    await harness.close()
  }
}

main().catch((error) => {
  console.error(`lanes demo failed: ${error?.stack ?? error}`)
  process.exitCode = 1
})
