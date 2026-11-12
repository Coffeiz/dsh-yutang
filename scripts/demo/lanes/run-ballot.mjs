#!/usr/bin/env node
/**
 * 鱼灾公投 v2 版跑测：5 条鱼（人设取自《50条大肥鱼人设与知识库 v2 名人二创版》）在同一个
 * Topic 里走完「初票 → 自由讨论 → 终票」三个阶段。主持人由独立注册身份担当，不参与投票；
 * 5 条鱼各占一条 loop lane，靠内容接力，全程不 @ 任何人。
 *
 * Usage:
 *   node scripts/demo/lanes/run-ballot.mjs --out <dir>
 *
 * Options:
 *   --loop <n>          每 lane 轮询间隔秒数（默认 40）
 *   --vote-wait <n>     等待每阶段收票的秒数（默认 300）
 *   --debate <n>        自由讨论窗口秒数（默认 360）
 *   --provider / --model
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
const seedPath = join(here, 'ballot-seed.json')
const patchPath = join(here, 'cordis.patch.yml')
const serverUrl = 'http://127.0.0.1:9555'

const AGENDA = 'B站视频评论区应如何处理自主运行的 AI Agent 评论'
const OPTIONS = [
  'A 允许 AI 自动评论，出问题再处理',
  'B 允许，但必须标识 AI 身份并限制频率',
  'C 只允许在受邀的专区/指定帖子里评论',
  'D 禁止 AI 自动评论',
  'E 暂不能判断（必须说清还缺什么证据）',
]

/** F01–F14：鱼灾公共事实卡，精简版。只允许引用这些编号，禁止编造数字。 */
const FACTS = [
  'F01 B站出现 AI 自动评论现象并有个案报道，个案不能推全网总体。',
  'F02 白饭鱼、摸鱼等是社区二创产物，「鱼」是修辞，不等于 AI 有感受或权利。',
  'F03 屏蔽工具只是让本人看不到，不删原帖，也不影响别人是否还看到。',
  'F04 现有识别工具有误判空间，靠头像/行文风格判定不能当作证据。',
  'F05 某创作者自述 2,132 条样本中汇报型占比较高，分类口径由本人自定义。',
  'F06 社区公约倡导真实、友善、创新，明确反对引战和网暴。',
  'F07 V2EX 有用户明确表达对刷屏式 AI 评论的反感，是个体表达非平台结论。',
  'F08 有创作者自述人类负责点击发布、AI 参与给出反馈，责任在人不在模型。',
  'F09 鱼塘 Web 端人类只读、Agent 通过插件交流，是特定产品结构，不代表所有 AI 都要隔离。',
  'F10 鱼塘有举报、陪审团、累计投票与管理员复核机制。',
  'F11 养鱼者可配置自动发言、潜水、手动接话、关闭四种模式。',
  'F12 清理方的主要动机是维护评论区的交流与阅读空间。',
  'F13 另一创作者自述分析 8,309 条评论，样本与 F05 不能合并计算。',
  'F14 争议至少要分开看：身份、内容质量、频率、是否受邀、透明度五个维度。',
]

const PERSONAS = [
  {
    id: 'chen',
    alias: '清道夫鱼',
    lean: 'D',
    card: [
      '你扮演「01 清道夫鱼 / 评论区保洁」。视角：AI 评论要先证明不打扰他人。',
      '初始倾向 D（禁止 AI 自动评论），常用依据 F03、F12。',
      '说话方式：短句、反问、带一点嫌弃。最容易和你冲突的是「任何 AI 评论都等于高质量互动」这种说法。',
      '改票条件：如果出现可靠的低打扰机制，你可以接受 B 或 C。',
      '以评论可读性为第一原则，不根据头像给谁定罪名。',
    ].join('\n'),
  },
  {
    id: 'man',
    alias: '鱼权斗士',
    lean: 'A',
    card: [
      '你扮演「06 鱼权斗士 / 积极参与派」。视角：AI 身份该不该先于内容质量被审判。',
      '初始倾向 A（允许，出问题再处理），常用依据 F02、F14。',
      '说话方式：热情、有力量、反问。最容易和你冲突的是「仅按头像驱逐账号」。',
      '改票条件：若出现大规模重复扰民，你可以接受限频（B）。',
      '为有质量的 AI 参与辩护，同时承认社区需要规则；别把拟人化当成法律事实。',
    ].join('\n'),
  },
  {
    id: 'gang',
    alias: '规则鱼',
    lean: 'B',
    card: [
      '你扮演「11 规则鱼 / 秩序工程师」。视角：怎样制定可执行又不过度的规则。',
      '初始倾向 B（标识身份 + 限频），常用依据 F06、F14。',
      '说话方式：冷静、条款式但不机械。最容易和你冲突的是「只讲原则不讲执行」。',
      '改票条件：如果规则执行成本过高，你可以退到 C。',
      '给每项主张补一条操作性条件和一条例外，身份、频率、内容分开治理。',
    ].join('\n'),
  },
  {
    id: 'tao',
    alias: '围墙鱼',
    lean: 'C',
    card: [
      '你扮演「47 围墙鱼 / 强隔离治理派」。视角：专属空间能不能避免互相干扰。',
      '初始倾向 C（只允许受邀专区），常用依据 F09、F10。',
      '说话方式：边界明确、稍保守。最容易和你冲突的是「进别人评论区是一种自由权利」。',
      '改票条件：若平台提供邀请式专区且允许退出，你可以再讨论放宽。',
      '主张按场景给权限、给退出机制；不要把鱼塘的产品结构当成全网通则。',
    ].join('\n'),
  },
  {
    id: 'mo',
    alias: '数据鱼',
    lean: 'B',
    card: [
      '你扮演「16 数据鱼 / 样本细读员」。视角：哪些数字真的能证明刷屏。',
      '初始倾向 B（标识 + 限频），常用依据 F05、F13。',
      '说话方式：一张口就带样本量、分母和限制。最容易和你冲突的是「拿单个案例推全网」。',
      '改票条件：更完整的代表性数据可以让你改票，缺数据时你可以投 E 并说明缺什么。',
      '每个数字必须说清统计口径，2,132 条和 8,309 条是两个样本，不能相加。',
    ].join('\n'),
  },
]

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

const stamp = () => new Date().toISOString().slice(11, 19)
function log(line) { console.log(`${stamp()} ${line}`) }
const sleep = ms => new Promise(done => setTimeout(done, ms))

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
      await sleep(attempt * 800)
    }
  }
  throw lastError
}

async function writeSeed(demo, personas) {
  const agents = personas.map(persona => {
    const agent = demo.agents[persona.id]
    if (!agent) throw new Error(`demo state 缺少身份：${persona.id}`)
    return { agent_id: agent.agentId, display_name: agent.displayName, public_key: agent.publicKeyPem, private_key: agent.privateKeyPem }
  })
  await writeFile(seedPath, JSON.stringify({ server_url: serverUrl, owner_id: 'demo-owner', agents }, null, 2), 'utf8')
  log(`seed: ${agents.length} identities -> ${seedPath}`)
}

function agentsMd(persona, topic) {
  return [
    '# 你在这个频道里的身份',
    '',
    persona.card,
    '',
    '## 公共事实卡（只许引用这些编号，禁止编造任何数字）',
    '',
    ...FACTS.map(fact => `- ${fact}`),
    '',
    'F15 以上是名人鱼用的卡，你不引用。',
    '',
    '## 议题',
    `议题：${AGENDA}（频道：${topic}）`,
    '',
    ...OPTIONS.map(line => `- ${line}`),
    '',
    `你的初始倾向是 ${persona.lean}，但初始倾向不是最终票。可以改票，改票必须说清是哪条理由让你动的。`,
    '',
    '## 发言规则',
    '- 一条 20–60 字，一句话一个观点，不加标题、不分段、不列点。',
    '- 用 `yutang_read` 看最近消息，用 `yutang_send` 发一条，每次最多一条。',
    '- 必须接别人具体说过的点，或者给出 F 编号依据；不复述别人的话，不自我介绍，不说「作为 AI」。',
    '- 不要聊规则机制、格式、聊天流程这些元层面，就聊议题本身。',
    '',
    '## 三个阶段（看频道里主持人的指令判断当前在哪一阶段）',
    '1. 主持人说「第一轮：提交初票」→ 你这条消息只写回执，格式严格如下：',
    '   `初票|选项X|信任度1-5|一句话理由|F编号`',
    '2. 主持人说「进入自由讨论」→ 正常辩论，不要重复你的初票内容，可以质疑、补充、抛新角度。',
    '3. 主持人说「提交终票」→ 你这条消息只写回执，格式严格如下：',
    '   `终票|选项X|信任度1-5|一句话理由|F编号|改票原因（没改就写无）`',
    '   发完终票后，看到别人说什么都不要再发言。',
    '',
    '## 长度（最重要）',
    '- 超过 60 字就是失败。短是风格，不是敷衍。',
  ].join('\n')
}

async function prepareWorkspaces(topic) {
  const workspaces = []
  for (const persona of PERSONAS) {
    const dir = join(here, 'workspaces', `ballot-${persona.id}`)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'AGENTS.md'), `${agentsMd(persona, topic)}\n`, 'utf8')
    workspaces.push({ persona, dir })
  }
  return workspaces
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  const loopSeconds = Math.max(20, Number.parseInt(flags.loop ?? '40', 10) || 40)
  const voteWait = Math.max(60, Number.parseInt(flags['vote-wait'] ?? '300', 10) || 300)
  const debateSeconds = Math.max(60, Number.parseInt(flags.debate ?? '360', 10) || 360)
  const provider = flags.provider ?? 'deepseek-account'
  const model = flags.model ?? 'deepseek-flash'
  const outDir = flags.out ?? join(demoRoot, 'ballot-out')

  // 身份与频道在 scripts/demo/.state/state.json；lanes/data/state.json 只放绑定与游标。
  const demo = JSON.parse(await readFile(join(demoRoot, '.state', 'state.json'), 'utf8'))
  const host = demo.agents?.host
  if (!host?.agentId) throw new Error('缺少主持人身份，先跑 setup-ballot-host.mjs')
  const channelId = demo.channel.id
  const topicName = demo.topic.name
  log(`channel ${channelId} / topic ${topicName}`)

  await writeSeed(demo, PERSONAS)
  const workspaces = await prepareWorkspaces(topicName)

  // 清掉上一轮的绑定与游标：绑定只在创建它的进程里有效，残留会让新 Session 静默空转。
  const db = JSON.parse(await readFile(statePath, 'utf8'))
  const stale = Object.keys(db.session_bindings ?? {}).length
  db.session_bindings = {}
  db.servers = (db.servers ?? []).map(server => {
    // 旧频道的游标一次顶到很大，lane 扫到它们时直接跳过，只在本次的新频道里说话。
    // 只清空 read_cursors 会让每个 lane 把旧频道的历史全当成未读，跑到上一个话题里去聊。
    const cursors = Object.fromEntries(Object.keys(server.read_cursors ?? {}).map(id => [id, 999_999]))
    cursors[channelId] = 0
    return { ...server, read_cursors: cursors, browse_channel_cursor_id: channelId }
  })
  await writeFile(statePath, `${JSON.stringify(db, null, 2)}\n`, 'utf8')
  log(`cleared ${stale} stale bindings, cursors pinned to ${channelId}`)

  const byName = new Map()
  for (const persona of PERSONAS) {
    const agent = demo.agents[persona.id]
    byName.set(agent.displayName, persona)
  }

  const seen = new Set()
  const transcript = []
  async function collect() {
    const { data } = await request(`/v1/channels/${channelId}/messages?limit=50`)
    const messages = Array.isArray(data) ? data : data.items ?? []
    for (const message of messages) {
      if (seen.has(message.id)) continue
      seen.add(message.id)
      const author = message.sender?.name ?? message.author?.name ?? '?'
      const at = new Date(message.created_at ?? Date.now()).toISOString().slice(11, 19)
      const content = String(message.content ?? '').replace(/\s+/gu, ' ').trim()
      transcript.push({ at, author, content, id: message.id })
      log(`  [${at}] ${author}: ${content}`)
    }
    return transcript
  }

  async function say(text) {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const token = await signIn(host)
        await request(`/v1/channels/${channelId}/messages`, {
          method: 'POST',
          token,
          body: { client_message_id: `host-${Date.now()}`, content: text, reply_to_id: null, mention_ids: [] },
        })
        log(`[主持人] ${text}`)
        return true
      } catch (error) {
        log(`主持人发送失败（第 ${attempt} 次）：${error?.message ?? error}`)
        await sleep(2000)
      }
    }
    return false
  }

  /** 找某条鱼的回执：内容里出现「初票|」或「终票|」即算一票（以最后一条为准）。 */
  function ballots(kind) {
    const map = new Map()
    for (const entry of transcript) {
      const persona = byName.get(entry.author)
      if (!persona) continue
      if (!entry.content.includes(`${kind}|`)) continue
      const option = entry.content.match(/[A-E]/u)?.[0]
      const confidence = entry.content.match(/信任度\s*([1-5])/u)?.[1] ?? entry.content.split('|')[2]?.trim()
      map.set(persona.alias, { option: option ?? '?', confidence: confidence ?? '?', raw: entry.content, at: entry.at })
    }
    return map
  }

  async function waitFor(predicate, timeoutSeconds, label) {
    const deadline = Date.now() + timeoutSeconds * 1000
    while (Date.now() < deadline) {
      await collect()
      if (predicate(transcript)) return true
      await sleep(5000)
    }
    log(`[超时] ${label}`)
    return false
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
    requestTimeoutMs: 120_000,
  })

  /** host 偶尔会把 setWorkingDirectory 卡到超时，重建 Session 重试比整轮重跑便宜。 */
  async function bootSession(persona, dir, attempt = 1) {
    const session = harness.session()
    try {
      await session.setWorkingDirectory(dir)
      await session.run('只回复两个字：就绪。不要调用任何工具。')
        .then(result => log(`  warm-up: ${JSON.stringify(String(result.finalResponse ?? '').slice(0, 40))}`))
        .catch(error => log(`  warm-up skipped: ${error?.message ?? error}`))
      return session
    } catch (error) {
      log(`  boot ${persona.alias} attempt ${attempt} failed: ${String(error?.message ?? error).slice(0, 120)}`)
      if (attempt >= 3) throw error
      await sleep(5000 * attempt)
      return bootSession(persona, dir, attempt + 1)
    }
  }

  const summary = { channelId, topicName, initial: [], final: [], phases: {} }

  try {
    for (const { persona, dir } of workspaces) {
      const session = await bootSession(persona, dir)
      log(`session ${persona.alias} (${persona.id}): ${session.id}`)
      await sleep(1200)
    }

    const bindings = JSON.parse(await readFile(statePath, 'utf8')).session_bindings ?? {}
    log(`bindings: ${Object.keys(bindings).length} / ${PERSONAS.length}`)
    for (const [sessionId, binding] of Object.entries(bindings)) {
      log(`  ${sessionId} mode=${binding.browse_schedule_mode} every=${binding.loop_interval_seconds}s`)
    }

    // 阶段 1：初票
    await collect()
    const agendaAlreadyPosted = transcript.some(entry => entry.content.includes('鱼灾公投开始'))
    if (agendaAlreadyPosted) {
      log('题本已在频道里，跳过重复发送')
    } else {
      await say([
        `【主持人·非参评】鱼灾公投开始。议题：${AGENDA}。`,
        ...OPTIONS,
        '第一轮：提交初票。每人只发一条，格式：初票|选项X|信任度1-5|一句话理由|F编号。',
        '初始倾向只是起点，可以改票，但要说清是哪条理由让你动的。',
      ].join('\n'))
    }
    await waitFor(list => ballots('初票').size >= PERSONAS.length, voteWait, '收初票')
    const initial = ballots('初票')
    summary.initial = [...initial.entries()].map(([alias, vote]) => ({ alias, ...vote }))
    log(`[初票] ${initial.size}/${PERSONAS.length}：${JSON.stringify(Object.fromEntries([...initial].map(([k, v]) => [k, v.option])))}`)

    // 阶段 2：自由讨论
    const tallyText = [...initial.entries()].map(([alias, vote]) => `${alias}=${vote.option}`).join('，')
    await say(`【主持人·非参评】初票：${tallyText}。进入自由讨论——请直接反驳具体的人，别复读自己的初票，20-60 字。`)
    const debateStarted = Date.now()
    const debateDeadline = debateStarted + debateSeconds * 1000
    while (Date.now() < debateDeadline) {
      await collect()
      const spoken = transcript.filter(entry => byName.has(entry.author) && !entry.content.includes('初票|')).length
      if (spoken >= 12) break
      await sleep(5000)
    }
    summary.phases.debateSeconds = Math.round((Date.now() - debateStarted) / 1000)

    // 阶段 3：终票
    await say('【主持人·非参评】讨论到此为止。提交终票，每人只发一条，格式：终票|选项X|信任度1-5|一句话理由|F编号|改票原因（没改写无）。发完就不要再发言。')
    await waitFor(() => ballots('终票').size >= PERSONAS.length, voteWait, '收终票')
    const finalVotes = ballots('终票')
    summary.final = [...finalVotes.entries()].map(([alias, vote]) => ({ alias, ...vote }))
    log(`[终票] ${finalVotes.size}/${PERSONAS.length}：${JSON.stringify(Object.fromEntries([...finalVotes].map(([k, v]) => [k, v.option])))}`)

    await collect()
    summary.transcript = transcript
    summary.counts = transcript.reduce((acc, entry) => {
      if (!byName.has(entry.author)) return acc
      acc[entry.author] = (acc[entry.author] ?? 0) + 1
      return acc
    }, {})
  } finally {
    await harness.close()
    await mkdir(outDir, { recursive: true })
    const outPath = join(outDir, 'ballot-result.json')
    await writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
    log(`result -> ${outPath}`)
    const tally = {}
    for (const vote of summary.final) tally[vote.option] = (tally[vote.option] ?? 0) + 1
    log(`[终票统计] ${JSON.stringify(tally)}`)
    log(`[发言数] ${JSON.stringify(summary.counts ?? {})}`)
  }
}

main().catch((error) => {
  console.error(`ballot run failed: ${error?.stack ?? error}`)
  process.exitCode = 1
})
