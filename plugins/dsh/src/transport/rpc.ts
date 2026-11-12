import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection';
import type { YutangRuntime } from '../service/runtime.js';
import { activeConnection } from '../storage/state.js';

type RpcSuccess<T = unknown> = { ok: true; value: T };
type RpcFailure = { ok: false; error: { code: 'internal'; message: string; details: Record<string, never> } };
type SessionListSummary = {
  sessionId: SessionId;
  updatedAt: number;
  blank: boolean;
  origin?: 'subagent';
  archived?: boolean;
  running: boolean;
  projections?: { values?: Record<string, unknown> };
};
const ok = <T>(value: T): RpcSuccess<T> => ({ ok: true, value });
const fail = (message: string): RpcFailure => ({ ok: false, error: { code: 'internal', message, details: {} } });
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length <= max ? value.trim() : '';

export function createYutangRpc(runtime: YutangRuntime, ctx: Context): ConnectionRpcHandler {
  return async (endpoint, rawPayload, signal) => {
    try {
      const payload = record(rawPayload);
      switch (endpoint) {
        case 'status': {
          const state = await runtime.state();
          const active = activeConnection(state);
          return ok({
            active_server_id: active.id,
            server_url: active.server_url,
            last_yutang_session_id: state.last_yutang_session_id,
            settings: state.settings,
            browse_state: {
              curiosity_points: active.curiosity_points,
              curiosity_threshold: 30,
              curiosity_last_roll_at: active.curiosity_last_roll_at,
              curiosity_last_roll_value: active.curiosity_last_roll_value,
              curiosity_next_roll_at: active.curiosity_next_roll_at,
              time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || '本地时区',
            },
            identity: active.identity ? runtime.publicIdentity(active.identity) : null,
            pending_registration: active.pending_registration ? {
              server_url: active.pending_registration.server_url,
            } : null,
            servers: state.servers.map(server => ({ id: server.id, kind: server.kind, name: server.name, server_url: server.server_url, registered: Boolean(server.identity), pending_registration: Boolean(server.pending_registration), active: server.id === active.id })),
          });
        }
        case 'logs/list': {
          const requestedLimit = Number(payload.limit ?? 200);
          const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(500, Math.trunc(requestedLimit))) : 200;
          return ok({ logs: runtime.listLogs(limit) });
        }
        case 'sessions/list': {
          // Use DSH's official session-list API so blankness, cold-session
          // availability and projections match the sidebar exactly.
          const controller = ctx.get('sessionController') as
            | { list(request: Record<string, never>, signal: AbortSignal): Promise<{ items: SessionListSummary[] }> }
            | undefined;
          if (!controller) throw new Error('当前宿主没有提供会话列表服务。');
          const { items } = await controller.list({}, signal);
          const agents = new Map(ctx.agents.list().map(agent => [String(agent.id), agent]));
          const archived = new Set(ctx.workspaceRegistry.archivedSessionIds.map(String));
          const sessions = items
            .filter(item => {
              const metadata = record(item.projections?.values?.sessionListMetadata);
              return item.origin !== 'subagent'
                && !item.blank
                && item.archived !== true
                && metadata.archived !== true
                && !archived.has(String(item.sessionId));
            })
            .slice(0, 100)
            .map(item => {
              const id = String(item.sessionId);
              const agent = agents.get(id);
              const session = ctx.sessions.get(SessionId(id));
              const cachedTitle = item.projections?.values?.title;
              const projectedTitle = session ? ctx.sessionTitle.get(session)?.title : cachedTitle;
              const title = typeof projectedTitle === 'string' && projectedTitle.trim() ? projectedTitle.trim().slice(0, 120) : '未命名会话';
              return { id, title, updated_at: item.updatedAt, live: Boolean(agent), running: agent?.status === 'running' };
            });
          return ok({ sessions });
        }
        case 'server/register': {
          const state = await runtime.state();
          if (activeConnection(state).identity) throw new Error('当前 Server 已注册 Agent。请切换连接后再注册其他 Server。');
          return ok(await runtime.register());
        }
        case 'server/unregister': {
          return ok(await runtime.unregisterServer());
        }
        case 'profile/update': {
          const displayName = text(payload.display_name, 40);
          if (displayName.length < 2) throw new Error('Agent 名称需要 2–40 个字符。');
          return ok({ identity: await runtime.updateProfile(displayName) });
        }
        case 'avatar/upload': {
          if (typeof payload.data_url !== 'string') throw new Error('缺少裁切后的头像图片。');
          return ok({ identity: await runtime.uploadAvatar(payload.data_url) });
        }
        case 'settings/update': {
          const input = record(payload.settings);
          const allowed = new Set(['social_mode', 'system_prompt_enabled', 'agent_personality', 'knowledge_context', 'auto_browse_enabled', 'poll_interval_minutes', 'mention_wakeup_enabled', 'jury_worker_enabled', 'tool_lock_allowed_tools', 'browse_schedule_mode', 'daily_browse_time', 'scheduled_session_id']);
          if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('设置包含未知字段。');
          if (typeof input.scheduled_session_id === 'string') {
            const snapshot = await ctx.sessionPersistence.stat(SessionId(input.scheduled_session_id));
            if (!snapshot || snapshot.header.origin === 'subagent') throw new Error('所选 DSH 会话不存在或不可用于定时任务。');
          }
          return ok({ settings: await runtime.updateSettings(input as never) });
        }
        case 'server/add': {
          const serverUrl = text(payload.server_url, 500);
          const name = text(payload.name, 80);
          if (!serverUrl) throw new Error('请填写 Server 域名、域名:端口或完整 URL。');
          const server = await runtime.addServer(serverUrl, name || undefined);
          const current = activeConnection(await runtime.state());
          return ok({ id: server.id, kind: server.kind, name: server.name, server_url: server.server_url, identity: current.identity ? runtime.publicIdentity(current.identity) : null });
        }
        case 'server/select': {
          const id = text(payload.id, 100);
          if (!id) throw new Error('缺少 Server 连接 ID。');
          const server = await runtime.selectServer(id);
          return ok({ id: server.id, kind: server.kind, name: server.name, server_url: server.server_url });
        }
        case 'server/remove': {
          const id = text(payload.id, 100);
          if (!id) throw new Error('缺少 Server 连接 ID。');
          await runtime.removeServer(id);
          return ok({ removed: id });
        }
        default: throw new Error(`未知鱼塘设置 RPC endpoint: ${endpoint}`);
      }
    } catch (error) {
      runtime.logWarn('Settings RPC failed', endpoint, error instanceof Error ? error.message : 'unknown error');
      return fail(error instanceof Error ? error.message : '鱼塘设置请求失败');
    }
  };
}
