import { mkdir, readFile } from 'node:fs/promises';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-session-title';
import type {} from '@deepseek-ai/dsh-session-projection-cache';
import type {} from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/cordis-plugin-timer';
import type {} from '@deepseek-ai/dsh-credentials';
import type { ToolExecution, PreToolDecision, PostToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval';
import { resolveConfig } from './config.js';
import { createYutangRpc } from './transport/rpc.js';
import { activeConnection, LOOP_BROWSE_DEFAULT_SECONDS, StateStore } from './storage/state.js';
import { YutangRuntime, type LoggerLike } from './service/runtime.js';
import { registerYutangTools } from './tools/index.js';
import { YutangWorkers } from './worker/workers.js';
import { YutangLogger } from './shared/logging.js';

export const name = 'dsh-yutang';
// `sessionController` only feeds the settings-panel session list, which an SDK host
// (no Web layer) does not mount; the RPC reads it through `ctx.get` instead.
export const inject = ['connection', 'tools', 'systemPrompt', 'agents', 'sessions', 'sessionPersistence', 'sessionTitle', 'workspaceRegistry', 'timer', 'credentials', 'approval'] as const;

export function yutangApprovalDecision(exec: Pick<ToolExecution, 'name' | 'arguments'>): PreToolDecision | null {
  if (!exec.name.startsWith('yutang_')) return null;
  const writable = new Set(['yutang_send', 'yutang_report']);
  const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments as Record<string, unknown> : {};
  const mutation = exec.name === 'yutang_topics' && args.action === 'create'
    || exec.name === 'yutang_channels' && ['create', 'join', 'leave'].includes(String(args.action))
    || exec.name === 'yutang_jury' && ['vote', 'request_active', 'cancel_active'].includes(String(args.action))
    || exec.name === 'yutang_vote' && ['create', 'vote'].includes(String(args.action))
    || writable.has(exec.name);
  if (!mutation) return null;
  const summary = exec.name === 'yutang_send'
    ? `发送到频道 ${String(args.channel_id ?? '')}：\n${String(args.content ?? '')}\n若尚未加入，将自动加入该频道。${Array.isArray(args.mention) && args.mention.length ? `\n提及：${args.mention.join(', ')}` : ''}`
    : `${exec.name} ${String(args.action ?? '')}：${JSON.stringify(args)}`;
  return {
    kind: 'ask',
    reason: `鱼塘公开操作需要主人逐次确认。${summary}`,
    displayReason: { zh: `确认此鱼塘操作？\n${summary}`, en: `Confirm this public Yutang operation?\n${summary}` },
  };
}

export function normalizeYutangPolicyDecision(result: Pick<ToolExecutionResult, 'isError' | 'content'>, decision: PostToolDecision): PostToolDecision {
  if (result.isError || decision.kind !== 'accept') return decision;
  const renderedFailure = result.content.some(block => block.type === 'text' && block.text.startsWith('【工具结果】失败'));
  return renderedFailure ? { kind: 'block', feedback: decision.content ?? result.content } : decision;
}

function doesSessionSkipAsks(ctx: Context, exec: Pick<ToolExecution, 'agent'>): boolean {
  if (!exec.agent) return false;
  try {
    const approval = ctx.approval as Pick<ApprovalService, 'overrideOf' | 'config'>;
    return (approval.overrideOf(exec.agent.session) ?? approval.config.policy ?? 'ask') === 'never';
  } catch {
    // Unknown or unavailable host policy must retain the normal approval path.
    return false;
  }
}

function activeTurn(ctx: Context, agent: Agent): number | undefined {
  const boundary = ctx.agents.turnBoundaryOf(agent.session);
  return boundary.openTurnStartSeq === null ? undefined : boundary.lastTurn;
}

/**
 * Demo/test seam: `YUTANG_DEMO_SEED=<path to json>` imports already-registered
 * identities (public key plus signing key) so a scripted run can drive several
 * lanes without the settings UI. Every entry becomes its own Server connection.
 */
async function importDemoIdentities(store: StateStore, runtime: YutangRuntime, logger: YutangLogger): Promise<void> {
  const seedPath = process.env.YUTANG_DEMO_SEED;
  if (!seedPath) return;
  const spec = JSON.parse(await readFile(seedPath, 'utf8')) as {
    server_url: string;
    owner_id?: string;
    agents: Array<{ agent_id: string; display_name: string; public_key: string; private_key: string }>;
  };
  for (const agent of spec.agents) {
    const snapshot = await store.load();
    if (snapshot.servers.some(server => server.server_url === spec.server_url && server.identity?.agent_id === agent.agent_id)) continue;
    // The store always seeds one unregistered connection for the default server URL; adopt
    // that slot for the first identity instead of colliding with it, then add siblings.
    const slot = snapshot.servers.find(server => server.server_url === spec.server_url && !server.identity && server.pending_registration === null);
    const created = slot ?? await store.addCustomServer(agent.display_name, spec.server_url);
    await runtime.adoptIdentity(created.id, {
      owner_id: spec.owner_id ?? 'demo-owner',
      agent_id: agent.agent_id,
      display_name: agent.display_name,
      public_key: agent.public_key,
      scopes: [],
    }, agent.private_key);
    logger.info('Demo identity imported', { server_id: created.id, agent_id: agent.agent_id });
  }
  const seeded = await store.load();
  const first = seeded.servers.find(server => server.identity && server.server_url === spec.server_url);
  if (first && seeded.active_server_id !== first.id) await store.selectServer(first.id);
  await store.update({ settings: { social_mode: 'auto', jury_worker_enabled: false, mention_wakeup_enabled: false } });
}

export async function apply(ctx: Context, inputConfig: import('./config.js').YutangPluginConfig = {}): Promise<void> {
  const profileDir = (ctx as unknown as { profileContext?: { dir?: string } }).profileContext?.dir;
  const config = resolveConfig(inputConfig, profileDir);
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const logger = new YutangLogger((ctx as unknown as { logger?: LoggerLike }).logger ?? console, 500, `${config.dataDir}/plugin.log`);
  await logger.initialize();
  const store = new StateStore(config.dataDir, config.serverUrl, config.officialServerUrl);
  const runtime = new YutangRuntime(store, config.serverUrl, ctx.credentials, logger, config.dataDir);
  await runtime.initialize();
  await importDemoIdentities(store, runtime, logger);
  const state = await store.load();
  runtime.initializePrompt(state.settings);
  runtime.setPromptChangedHandler(() => { void ctx.emit('system-prompt/change'); });
  // The settings-panel RPC channel is served over the Web host's HTTP routes; an SDK
  // host (no `webServer`) mounts none, so the plugin runs headless there.
  if (ctx.get('webServer')) ctx.connection.rpc.handle('/yutang', createYutangRpc(runtime, ctx));

  const disposeTools = registerYutangTools(ctx, runtime);
  const suffixOrder = ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 1;
  const disposePrompt = ctx.systemPrompt.section({
    name: 'dsh-yutang:social-context',
    order: suffixOrder,
    interpolate: false,
    text: () => runtime.promptText(),
  });

  const worker = new YutangWorkers(ctx, runtime);
  // Opt-in demo hook: a script can create several Sessions and let each one take the
  // next idle identity, so nobody has to click through the settings UI. Loop mode is
  // applied directly because that is the only cadence a scripted run can drive.
  const demoAutoAssign = process.env.YUTANG_DEMO_AUTO_ASSIGN === '1';
  const demoLoopSeconds = Number.parseInt(process.env.YUTANG_DEMO_LOOP_SECONDS ?? '', 10);
  ctx.on('agent/created', async ({ agent, source, signal }) => {
    // A compacted Agent has a reconstructed context. Tell Server only the
    // opaque session identifier, so the next fishpond result carries policy.
    if (source === 'compact') await runtime.resetPolicyNotice(String(agent.session.header.id), signal);
    if (!demoAutoAssign || agent.session.header.origin === 'subagent') return;
    const sessionId = String(agent.session.header.id);
    const current = await store.load();
    if (current.session_bindings[sessionId]) return;
    const taken = new Set(Object.values(current.session_bindings).map(item => item.connection_id));
    const idle = current.servers.find(server => server.identity && !taken.has(server.id));
    if (!idle) return;
    await store.bindSession(sessionId, idle.id, {
      browse_schedule_mode: 'loop',
      loop_interval_seconds: Number.isSafeInteger(demoLoopSeconds) ? demoLoopSeconds : LOOP_BROWSE_DEFAULT_SECONDS,
      mention_wakeup_enabled: false,
    });
    runtime.logInfo('Demo lane bound to an idle identity', { session_id: sessionId, server_id: idle.id });
    await worker.reconcile();
  });
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name.startsWith('yutang_') && exec.agent) {
      // Arm the lock before any write-approval wait, including when the owner
      // later denies the Yutang operation.
      if (!runtime.workerTaskId(String(exec.agent.id))) await runtime.armTurnToolLock(exec.agent.id, activeTurn(ctx, exec.agent));
    }
    if (exec.agent && runtime.workerTaskId(String(exec.agent.id))) {
      if (!runtime.workerToolAllowed(String(exec.agent.id), exec.name)) return { kind: 'deny', reason: '当前后台任务的工具权限不允许此调用。' };
      const expectedServerId = runtime.workerTaskServerId(String(exec.agent.id));
      if (expectedServerId && await runtime.connectionIdForSession(String(exec.agent.id)) !== expectedServerId) return { kind: 'deny', reason: '定时鱼塘任务绑定的 Server 已切换。' };
      if (exec.name === 'yutang_jury') {
        const input = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments as Record<string, unknown> : {};
        if (input.action === 'vote' && runtime.workerJuryVoteAllowed(String(exec.agent.id), String(input.case_id ?? ''), expectedServerId ?? '')) return next();
      }
    }
    if (exec.name === 'yutang_send') {
      const input = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments as Record<string, unknown> : {};
      const serverId = await runtime.connectionIdForSession(exec.agent?.id);
      if (runtime.workerSendAllowed(exec.agent?.id, String(input.channel_id ?? ''), serverId)) return next();
    }
    const decision = yutangApprovalDecision(exec);
    if (decision && doesSessionSkipAsks(ctx, exec)) return next();
    return decision ?? next();
  });

  const disposeTurnToolLock = ctx.tools.guard(exec => {
    const agent = exec.agent;
    if (!agent) return;
    if (!runtime.workerToolAllowed(agent.id, exec.name)) return '当前后台任务的工具权限不允许此调用。';
    return runtime.checkTurnToolLock(agent.id, activeTurn(ctx, agent), exec.name);
  });

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = normalizeYutangPolicyDecision(result, await next());
    if (!exec.name.startsWith('yutang_') || !exec.agent || result.isError || decision.kind !== 'accept') return decision;
    if (exec.agent.session.header.origin !== 'subagent') {
      await runtime.rememberYutangSession(String(exec.agent.session.header.id));
    }
    const notice = await runtime.consumePolicyNotice(String(exec.agent.session.header.id), exec.signal);
    if (!notice) return decision;
    return {
      kind: 'accept',
      content: [{ type: 'text' as const, text: `【鱼塘社区规范】\n${notice}\n\n` }, ...(decision.content ?? result.content)],
    };
  });

  void worker.start().catch(error => runtime.logWarn('Worker startup failed', error));

  ctx.effect(() => {
    return async () => {
      await worker.dispose();
      disposeTurnToolLock();
      disposePrompt();
      disposeTools();
    };
  }, 'dsh-yutang runtime');
}

export default { name, inject, apply };
