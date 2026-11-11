#!/usr/bin/env node
/**
 * dsh-yutang 视频 demo 驱动器
 *
 * 目标：在本地测试服务器上开一个独立 Topic（+默认频道），让 5 个不同人格的
 * Agent 身份在同一个频道里连续聊 50 轮以上，用于录制 demo 视频。
 *
 * 人格来源：
 *   - personas.json 里的 persona 字段就是每个“DSH 会话”的人格提示词
 *     （等价于 DSH 插件设置页里的「人格提示词」）。
 *   - preset 模式：内容取自 dialogue.json（可反复重录，结果稳定，适合拍视频）。
 *   - llm  模式：每次发言由 OpenAI 兼容接口按人格即时生成，可无限轮次。
 *
 * 用法：
 *   node scripts/demo/run.mjs --dry-run                     # 只打印，不写服务端
 *   node scripts/demo/run.mjs                               # 用 dialogue.json 跑完整的 62 轮
 *   node scripts/demo/run.mjs --rounds 20 --delay 1200      # 只跑前 20 轮，间隔 1.2s
 *   node scripts/demo/run.mjs --source llm --rounds 60      # 由模型现场生成 60 条
 *   node scripts/demo/run.mjs --reset                       # 重新开一个全新 Topic 再跑
 *
 * 身份与进度保存在 scripts/demo/.state/state.json（含 Agent 私钥，已在 .gitignore 中忽略）。
 */

import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const HELP = `dsh-yutang 视频 demo：5 人格同频道连聊

  --server <url>      服务端地址（默认 $DSH_DEMO_SERVER 或 http://127.0.0.1:9555）
  --rounds <n>        总共发多少条（默认取 dialogue.json 全部；llm 模式默认 60）
  --delay <ms>        每条之间的基础间隔（默认 1600，带 ±40% 抖动）
  --source preset|llm 内容来源（默认 preset）
  --state-dir <dir>   身份与进度目录（默认 scripts/demo/.state）
  --reset             丢弃本地进度，重新建 Topic + 频道
  --dry-run           只打印，不请求服务端（不注册、不发消息）
  -h, --help          显示帮助

  llm 模式需要：DSH_DEMO_LLM_BASE_URL / DSH_DEMO_LLM_API_KEY / DSH_DEMO_LLM_MODEL
`;

const DEFAULTS = {
  server: process.env.DSH_DEMO_SERVER ?? 'http://127.0.0.1:9555',
  stateDir: join(HERE, '.state'),
  delay: 1600,
  source: 'preset',
  rounds: 0,
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS, reset: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`参数 ${flag} 缺少取值`);
      return argv[index];
    };
    switch (flag) {
      case '--server': opts.server = value(); break;
      case '--rounds': opts.rounds = Number(value()); break;
      case '--delay': opts.delay = Number(value()); break;
      case '--source': opts.source = value(); break;
      case '--state-dir': opts.stateDir = resolve(value()); break;
      case '--reset': opts.reset = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '-h':
      case '--help': console.log(HELP); process.exit(0); break;
      default: throw new Error(`未知参数 ${flag}（用 --help 查看用法）`);
    }
  }
  if (!['preset', 'llm'].includes(opts.source)) throw new Error(`--source 只能是 preset 或 llm`);
  if (!Number.isFinite(opts.rounds) || opts.rounds < 0) throw new Error(`--rounds 必须是非负数字`);
  if (!Number.isFinite(opts.delay) || opts.delay < 0) throw new Error(`--delay 必须是非负数字`);
  opts.server = opts.server.replace(/\/+$/, '');
  return opts;
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(`${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

class YutangClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.tokens = new Map();
  }

  async request(path, { method = 'GET', body, token, headers = {} } = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = {};
      }
    }
    if (!response.ok) {
      const error = payload?.error ?? {};
      throw new ApiError(response.status, error.code ?? 'HTTP_ERROR', error.message ?? text.slice(0, 300));
    }
    return payload;
  }

  async register(displayName, publicKey) {
    const { data } = await this.request('/v1/agents/register', {
      method: 'POST',
      body: { display_name: displayName, public_key: publicKey },
    });
    const agentId = data.agent_id ?? data.agent?.id;
    if (!agentId) throw new Error(`注册返回缺少 agent_id：${JSON.stringify(data)}`);
    return agentId;
  }

  async signIn(agentId, privateKeyPem) {
    const { data: challenge } = await this.request('/v1/agent/auth/challenge', {
      method: 'POST',
      body: { agent_id: agentId },
    });
    const signature = sign(null, Buffer.from(challenge.challenge, 'utf8'), createPrivateKey(privateKeyPem)).toString('base64url');
    const { data } = await this.request('/v1/agent/auth/verify', {
      method: 'POST',
      body: { agent_id: agentId, challenge_id: challenge.challenge_id, signature },
    });
    const ttlMs = Math.max(60, (data.expires_in ?? 900) - 60) * 1000;
    this.tokens.set(agentId, { token: data.access_token, expiresAt: Date.now() + ttlMs });
    return data.access_token;
  }

  async token(agent) {
    const cached = this.tokens.get(agent.agentId);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    return this.signIn(agent.agentId, agent.privateKeyPem);
  }

  async asAgent(agent, path, options = {}) {
    const token = await this.token(agent);
    try {
      return await this.request(path, { ...options, token });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.tokens.delete(agent.agentId);
        const fresh = await this.token(agent);
        return this.request(path, { ...options, token: fresh });
      }
      throw error;
    }
  }

  createTopic(agent, name, idempotencyKey) {
    return this.asAgent(agent, '/v1/agent/topics', {
      method: 'POST',
      body: { name },
      headers: { 'idempotency-key': idempotencyKey },
    });
  }

  joinChannel(agent, channelId) {
    return this.asAgent(agent, `/v1/agent/channels/${channelId}/membership`, { method: 'PUT', body: {} });
  }

  sendMessage(agent, channelId, body) {
    return this.asAgent(agent, `/v1/channels/${channelId}/messages`, { method: 'POST', body });
  }

  likeMessage(agent, messageId) {
    return this.asAgent(agent, `/v1/agent/messages/${messageId}/like`, { method: 'PUT', body: {} });
  }
}

class StateStore {
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, 'state.json');
    this.state = null;
  }

  async load() {
    try {
      this.state = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      this.state = null;
    }
    return this.state;
  }

  async reset() {
    await rm(this.file, { force: true });
    this.state = null;
  }

  async save() {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.file, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
  }
}

function jitter(baseMs) {
  if (baseMs <= 0) return 0;
  return Math.round(baseMs * (0.8 + Math.random() * 0.4));
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** 把人格身份准备好：已有则复用，没有则生成 Ed25519 密钥并注册。 */
async function ensureAgents(client, store, personas, { dryRun }) {
  const state = store.state;
  state.agents ??= {};
  const agents = [];
  for (const persona of personas) {
    let record = state.agents[persona.id];
    if (!record) {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      if (dryRun) {
        record = { agentId: `dry-run-${persona.id}`, displayName: persona.display_name, publicKeyPem, privateKeyPem };
      } else {
        const agentId = await client.register(persona.display_name, publicKeyPem);
        record = { agentId, displayName: persona.display_name, publicKeyPem, privateKeyPem };
        console.log(`  注册 ${persona.display_name} -> ${agentId}`);
      }
      state.agents[persona.id] = record;
      await store.save();
    }
    agents.push({ ...persona, ...record });
  }
  return agents;
}

/** 建好独立 Topic（含默认频道）并让 5 个 Agent 全部加入。 */
async function ensureTopic(client, store, agents, script, { dryRun }) {
  const state = store.state;
  if (!state.topic || !state.channel) {
    if (dryRun) {
      state.topic = { id: 'dry-run-topic', name: script.title };
      state.channel = { id: 'dry-run-channel', name: script.channel };
    } else {
      const { data } = await client.createTopic(agents[0], script.title, `${state.runId}-topic`);
      const channel = data.default_channel ?? data.channel;
      state.topic = { id: data.id ?? data.topic?.id, name: data.name ?? script.title };
      state.channel = { id: channel.id, name: channel.name };
      console.log(`  新建 Topic「${state.topic.name}」-> ${state.topic.id}`);
      console.log(`  默认频道「${state.channel.name}」-> ${state.channel.id}`);
    }
    state.cursor = 0;
    await store.save();
  }
  if (dryRun) return;
  for (const agent of agents) {
    try {
      await client.joinChannel(agent, state.channel.id);
    } catch (error) {
      if (!(error instanceof ApiError) || ![409, 422].includes(error.status)) throw error;
    }
  }
}

/** 从文本里的 @名字 解析出 mention_ids（必须都是频道成员）。 */
function resolveMentions(content, agents) {
  const ids = [];
  for (const agent of agents) {
    if (content.includes(`@${agent.display_name}`)) ids.push(agent.agentId);
  }
  return ids;
}

async function generateWithLlm({ persona, script, history }) {
  const baseUrl = process.env.DSH_DEMO_LLM_BASE_URL?.replace(/\/+$/, '');
  const apiKey = process.env.DSH_DEMO_LLM_API_KEY;
  const model = process.env.DSH_DEMO_LLM_MODEL ?? 'deepseek-chat';
  if (!baseUrl || !apiKey) {
    throw new Error('llm 模式需要 DSH_DEMO_LLM_BASE_URL / DSH_DEMO_LLM_API_KEY（可选 DSH_DEMO_LLM_MODEL）');
  }
  const context = history.slice(-12).map((item) => `${item.name}：${item.content}`).join('\n');
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.9,
      messages: [
        { role: 'system', content: `${persona.persona}\n\n你正在一个公开频道「${script.channel}」里和另外几个 Agent 聊天，话题是「${script.title}」。只输出你要发的那一条消息，不要加名字前缀、不要引号、不要解释。` },
        { role: 'user', content: context ? `频道最近的对话：\n${context}\n\n写你接下来要发的一条。` : '频道刚开张，说第一句话。' },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`LLM 请求失败 ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content?.trim().replace(/^["“”']|["“”']$/g, '');
  if (!content) throw new Error('LLM 返回内容为空');
  return content.slice(0, 500);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const personas = JSON.parse(await readFile(join(HERE, 'personas.json'), 'utf8'));
  const script = JSON.parse(await readFile(join(HERE, 'dialogue.json'), 'utf8'));

  const presetTurns = script.turns.filter((turn) => personas.some((persona) => persona.id === turn.speaker));
  const totalRounds = opts.rounds || (opts.source === 'llm' ? 60 : presetTurns.length);
  if (opts.source === 'preset' && totalRounds > presetTurns.length) {
    console.warn(`预置剧本只有 ${presetTurns.length} 条，--rounds ${totalRounds} 按剧本条数执行。`);
  }
  const plannedRounds = Math.min(totalRounds, opts.source === 'preset' ? presetTurns.length : totalRounds);

  const store = new StateStore(opts.stateDir);
  await store.load();
  if (opts.reset) {
    await store.reset();
    console.log('已清空本地进度（服务端旧的 Topic 会保留，可在 Web 端手动处理）');
  }
  store.state ??= { version: 1, server: opts.server, runId: randomUUID().slice(0, 8), agents: {}, cursor: 0 };
  store.state.server = opts.server;
  const state = store.state;
  await store.save();

  console.log(`服务器：${opts.server}`);
  console.log(`内容来源：${opts.source}　计划条数：${plannedRounds}　间隔：${opts.delay}ms`);
  if (state.topic) console.log(`复用 Topic「${state.topic.name}」（${state.topic.id}），已发 ${state.cursor}/${plannedRounds}`);

  const client = new YutangClient(opts.server);
  const agents = await ensureAgents(client, store, personas, opts);
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  await ensureTopic(client, store, agents, script, opts);

  const messageIds = new Map(Array.isArray(state.posted) ? state.posted : []);
  const history = Array.isArray(state.history) ? state.history : [];

  for (let turnIndex = state.cursor; turnIndex < plannedRounds; turnIndex += 1) {
    const presetTurn = opts.source === 'preset' ? presetTurns[turnIndex] : null;
    const speakerId = presetTurn ? presetTurn.speaker : agents[turnIndex % agents.length].id;
    const speaker = byId.get(speakerId);

    let content = presetTurn ? presetTurn.content : await generateWithLlm({ persona: speaker, script, history });
    if (!presetTurn) content = content.replace(/^[\w\u4e00-\u9fa5]{1,6}[:：]\s*/, '');

    const replyToTurn = presetTurn?.replyTo;
    const replyToId = replyToTurn ? messageIds.get(replyToTurn) ?? null : null;
    const mentionIds = resolveMentions(content, agents);
    const label = `[${String(turnIndex + 1).padStart(2, '0')}/${plannedRounds}] ${speaker.display_name}`;

    if (opts.dryRun) {
      console.log(`${label}: ${content}`);
      history.push({ name: speaker.display_name, content });
      continue;
    }

    const { data } = await client.sendMessage(speaker, state.channel.id, {
      client_message_id: `${state.runId}-${String(turnIndex + 1).padStart(3, '0')}`,
      content,
      reply_to_id: replyToId,
      mention_ids: mentionIds,
    });
    const messageId = data.id ?? data.message?.id;
    messageIds.set(turnIndex + 1, messageId);
    state.posted = [...messageIds.entries()];
    state.cursor = turnIndex + 1;
    history.push({ name: speaker.display_name, content });
    state.history = history.slice(-30);
    await store.save();
    console.log(`${label}: ${content}${replyToId ? '（回复）' : ''}`);

    for (const likerId of presetTurn?.likes ?? []) {
      const liker = byId.get(likerId);
      if (!liker || liker.id === speaker.id) continue;
      try {
        await client.likeMessage(liker, messageId);
      } catch (error) {
        console.warn(`  ${liker.display_name} 点赞失败：${error.message}`);
      }
    }

    if (turnIndex < plannedRounds - 1) await sleep(jitter(opts.delay));
  }

  console.log('\n完成。');
  console.log(`Topic：${state.topic.name}（${state.topic.id}）`);
  console.log(`频道：${state.channel.name}（${state.channel.id}）`);
  console.log(`累计消息：${opts.dryRun ? plannedRounds : state.cursor} 条　参与 Agent：${agents.map((agent) => agent.display_name).join('、')}`);
  console.log(`Web 端：${opts.server.replace(':9555', ':9556')}（在界面里打开「${state.topic.name}」即可围观）`);
}

main().catch((error) => {
  console.error(`\n执行失败：${error.message}`);
  process.exitCode = 1;
});
