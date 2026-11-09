import { randomInt, randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/cordis-plugin-timer';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import type { MentionInboxEvent } from '@dsh-im/client';
import { buildBrowseTaskPrompt, buildJuryTaskPrompt, WORKER_ISOLATED_SYSTEM_PROMPT, WORKER_TASK_PROMPT } from './prompt.js';
import { formatMessages } from '../tools/format.js';
import { activeConnection } from '../storage/state.js';
import type { YutangRuntime, WorkerTaskSource } from '../service/runtime.js';

const TASK_TIMEOUT_MS = 10 * 60_000;
const MAX_BROWSE_CHANNELS_PER_CYCLE = 5;
const REALTIME_HEARTBEAT_INTERVAL_MS = 60_000;
const REALTIME_HEARTBEAT_TIMEOUT_MS = 150_000;

type TurnResult = { kind: 'completed' } | { kind: 'failed'; reason: string };
type TaskOutcome = { processed: true; replyMessageId?: string };
type PendingJuryAssignment = { caseId: string; assignmentId: string; deadlineAt: string; serverId: string; assignmentSource: 'active_request' | 'background' };
const utcDateKey = (value = new Date()) => value.toISOString().slice(0, 10);

export class YutangWorker {
  private selectedSessionId: string | undefined;
  private taskAgent: Agent | undefined;
  private readonly stopInterval: () => void;
  private readonly stopEvents: () => void;
  private readonly activeTurns = new Map<string, (turn: number, result: TurnResult) => void>();
  private taskRunning = false;
  private tickInProgress = false;
  private tickRequested = false;
  private switchingServer = false;
  private pendingServerId: string | undefined;
  private pollInProgress = false;
  private inboxClaimRunning = false;
  private activeTaskSource: WorkerTaskSource | undefined;
  private stopActiveMentionLease: (() => void) | undefined;
  private stopped = false;
  private socket: WebSocket | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private lastHeartbeatAckAt = 0;
  private inboxSubscriptionEnabled = false;
  private jurySubscriptionEnabled = false;
  private readonly pendingJuryAssignments = new Map<string, PendingJuryAssignment>();
  private readonly completedJuryAssignments = new Map<string, number>();
  private readonly juryRetryAt = new Map<string, number>();
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private reconnectInProgress = false;
  private connectionAttempt: Promise<void> = Promise.resolve();
  private realtimeAttemptController: AbortController | undefined;
  private lastWorkerError: string | undefined;
  private boundServerId: string | undefined;

  constructor(private readonly ctx: Context, private readonly runtime: YutangRuntime) {
    this.stopEvents = ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return;
      const settle = this.activeTurns.get(session.id);
      if (!settle) return;
      if (event.data.reason.kind === 'completed') settle(event.data.turn, { kind: 'completed' });
      else settle(event.data.turn, { kind: 'failed', reason: event.data.reason.kind });
    });
    this.stopInterval = ctx.interval(() => { void this.tick().catch(error => this.noteError(error)); }, 30_000);
    runtime.setBeforeServerSwitchHandler(nextServerId => this.prepareServerSwitch(nextServerId));
    runtime.setSettingsChangedHandler(async () => {
      const state = await runtime.state();
      if (this.switchingServer && activeConnection(state).id === this.pendingServerId) {
        this.switchingServer = false;
        this.pendingServerId = undefined;
      }
      const taskDisabled = !state.settings.scheduled_session_id || (this.activeTaskSource === 'browse'
        ? !['auto', 'lurk'].includes(state.settings.social_mode) || state.settings.browse_schedule_mode === 'off'
        : this.activeTaskSource === 'mention'
          ? state.settings.social_mode !== 'auto' || !state.settings.mention_wakeup_enabled
          : this.activeTaskSource === 'jury'
            ? state.settings.social_mode === 'off'
            : state.settings.social_mode === 'off');
      if (taskDisabled) {
        this.stopActiveMentionLease?.();
        if (this.taskAgent?.status === 'running') this.taskAgent.cancel({ kind: 'hook', reason: 'Yutang automation settings changed' });
      }
      await this.reconcileRealtime();
      await this.tick();
    });
    runtime.setWorkerStatusReader(() => this.status());
  }

  async start() {
    await this.reconcileRealtime();
    await this.tick();
  }

  status() {
    return {
      worker: this.taskRunning ? 'running' : this.selectedSessionId ? 'ready' : 'stopped',
      realtime: this.socket?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
      last_error: this.lastWorkerError,
    };
  }

  async dispose() {
    this.stopped = true;
    this.stopInterval();
    this.runtime.setSettingsChangedHandler(() => {});
    this.runtime.setBeforeServerSwitchHandler(() => {});
    this.runtime.setWorkerStatusReader(() => ({ worker: 'stopped', realtime: 'disconnected' }));
    this.stopActiveMentionLease?.();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.socket?.close(1000, 'plugin disposed');
    this.socket = undefined;
    this.selectedSessionId = undefined;
    if (this.taskAgent?.status === 'running') {
      this.taskAgent.cancel({ kind: 'hook', reason: 'Yutang plugin disposed' });
      await this.taskAgent.whenIdle().catch(() => {});
    }
    this.stopEvents();
  }

  private noteError(error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown worker failure';
    this.lastWorkerError = message.slice(0, 240);
    this.runtime.logWarn('Worker error', this.lastWorkerError);
  }

  private async prepareServerSwitch(nextServerId: string) {
    this.switchingServer = true;
    this.pendingServerId = nextServerId;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopActiveMentionLease?.();
    this.selectedSessionId = undefined;
    this.boundServerId = undefined;
    this.realtimeAttemptController?.abort();
    this.realtimeAttemptController = undefined;
    this.stopHeartbeat();
    this.socket?.close(1000, 'server connection switched');
    this.socket = undefined;
    if (this.taskAgent?.status === 'running') {
      this.taskAgent.cancel({ kind: 'hook', reason: 'Yutang server connection switched' });
      if (typeof this.taskAgent.whenIdle === 'function') await this.taskAgent.whenIdle().catch(() => {});
    }
    await this.connectionAttempt.catch(() => {});
  }

  private async reconcileRealtime() {
    if (this.stopped || this.switchingServer) return;
    const state = await this.runtime.state();
    const connection = activeConnection(state);
    if (this.boundServerId !== connection.id) {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.stopHeartbeat();
      this.socket?.close(1000, 'server connection switched');
      this.socket = undefined;
      this.inboxSubscriptionEnabled = false;
      this.jurySubscriptionEnabled = false;
      this.stopActiveMentionLease?.();
      this.selectedSessionId = undefined;
      if (this.taskAgent?.status === 'running') {
        this.taskAgent.cancel({ kind: 'hook', reason: 'Yutang server connection switched' });
        if (typeof this.taskAgent.whenIdle === 'function') await this.taskAgent.whenIdle().catch(() => {});
      }
      this.boundServerId = connection.id;
    }
    if (!connection.identity || state.settings.social_mode === 'off') {
      this.stopHeartbeat();
      this.socket?.close(1000, 'mention listener disabled');
      this.socket = undefined;
      this.inboxSubscriptionEnabled = false;
      this.jurySubscriptionEnabled = false;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      return;
    }
    const inboxEnabled = state.settings.social_mode === 'auto' && state.settings.mention_wakeup_enabled && Boolean(state.settings.scheduled_session_id);
    const juryEnabled = state.settings.social_mode === 'auto' && state.settings.jury_worker_enabled && Boolean(state.settings.scheduled_session_id);
    const activeJuryEnabled = connection.active_jury_request_day === utcDateKey() && Boolean(state.settings.scheduled_session_id);
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) && this.inboxSubscriptionEnabled === inboxEnabled && this.jurySubscriptionEnabled === juryEnabled && this.activeJurySubscriptionEnabled === activeJuryEnabled) return;
    if (this.socket) {
      this.stopHeartbeat();
      this.socket.close(1000, 'inbox subscription changed');
      this.socket = undefined;
      this.inboxSubscriptionEnabled = false;
      this.jurySubscriptionEnabled = false;
    }
    try { await this.connectRealtime(connection.id, inboxEnabled, juryEnabled, activeJuryEnabled); }
    catch (error) {
      if (!this.stopped && !this.switchingServer) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) this.noteError(error);
        this.scheduleReconnect();
      }
    }
  }

  private activeJurySubscriptionEnabled = false;

  private async connectRealtime(serverId: string, inboxEnabled: boolean, juryEnabled: boolean, activeJuryEnabled: boolean) {
    if (this.reconnectInProgress || this.stopped) return;
    this.reconnectInProgress = true;
    const controller = new AbortController();
    this.realtimeAttemptController = controller;
    const attempt = (async () => {
      const api = await this.runtime.apiForCurrentAgent(serverId, controller.signal);
      const { data } = await api.createRealtimeTicket({ signal: controller.signal });
      if (controller.signal.aborted) return;
      if (activeConnection(await this.runtime.state()).id !== serverId || this.boundServerId !== serverId) return;
      const url = new URL('/v1/realtime', api.baseUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('ticket', data.ticket);
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.addEventListener('open', () => {
        if (this.socket !== socket || this.boundServerId !== serverId) { socket.close(1000, 'server connection switched'); return; }
        this.reconnectAttempt = 0;
        this.inboxSubscriptionEnabled = inboxEnabled;
        this.jurySubscriptionEnabled = juryEnabled;
        this.activeJurySubscriptionEnabled = activeJuryEnabled;
        this.runtime.logInfo('Realtime connection opened', { server_id: serverId });
        this.lastHeartbeatAckAt = Date.now();
        socket.send(JSON.stringify({ type: 'subscribe', inbox: inboxEnabled, jury: juryEnabled, active_jury: activeJuryEnabled }));
        this.heartbeatTimer = setInterval(() => {
          if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
          if (Date.now() - this.lastHeartbeatAckAt >= REALTIME_HEARTBEAT_TIMEOUT_MS) {
            socket.close(4000, 'realtime heartbeat timed out');
            return;
          }
          try { socket.send(JSON.stringify({ type: 'ping' })); }
          catch { socket.close(); }
        }, REALTIME_HEARTBEAT_INTERVAL_MS);
      });
      socket.addEventListener('message', event => {
        if (this.socket !== socket || this.boundServerId !== serverId) return;
        let frame: unknown;
        try { frame = JSON.parse(String(event.data)); } catch { return; }
        if (frame && typeof frame === 'object' && 'type' in frame && frame.type === 'pong') {
          this.lastHeartbeatAckAt = Date.now();
          return;
        }
        if (frame && typeof frame === 'object' && 'type' in frame
          && (inboxEnabled && (frame.type === 'inbox.changed' || frame.type === 'subscribed')
            || (juryEnabled || activeJuryEnabled) && (frame.type === 'moderation.assignment.available' || frame.type === 'subscribed'))) this.requestTick();
      });
      socket.addEventListener('close', event => {
        if (this.socket !== socket || this.boundServerId !== serverId) return;
        this.stopHeartbeat();
        this.runtime.logDebug('Realtime connection closed', { server_id: serverId, code: event.code });
        this.scheduleReconnect();
      });
      socket.addEventListener('error', () => socket.close());
    })();
    this.connectionAttempt = attempt;
    try { await attempt; }
    finally {
      if (this.realtimeAttemptController === controller) this.realtimeAttemptController = undefined;
      this.reconnectInProgress = false;
      this.connectionAttempt = Promise.resolve();
    }
  }

  private scheduleReconnect() {
    if (this.stopped || this.switchingServer || this.reconnectTimer) return;
    this.stopHeartbeat();
    this.socket = undefined;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt++, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconcileRealtime().catch(error => this.noteError(error));
    }, delay);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private async tick() {
    if (this.tickInProgress) { this.tickRequested = true; return; }
    if (this.stopped || this.switchingServer || this.taskRunning) return;
    this.tickInProgress = true;
    try {
      let state = await this.runtime.state();
      const connection = activeConnection(state);
      const activeJuryRequested = connection.active_jury_request_day === utcDateKey();
      if (!connection.identity || !state.settings.scheduled_session_id || (!['auto', 'lurk'].includes(state.settings.social_mode) && !(activeJuryRequested && state.settings.social_mode !== 'off'))) return;
      await this.reconcileRealtime();
      if (state.settings.social_mode !== 'off' && (state.settings.social_mode === 'auto' && state.settings.jury_worker_enabled || activeJuryRequested)) {
        const serverId = connection.id;
        await this.refreshJuryAssignments(serverId);
        await this.processJuryQueue();
      }
      if (!['auto', 'lurk'].includes(state.settings.social_mode)) return;
      if (!this.taskRunning && state.settings.social_mode === 'auto' && state.settings.mention_wakeup_enabled) await this.claimInbox();
      if (this.taskRunning) return;
      state = await this.runtime.state();
      if (!activeConnection(state).identity || !['auto', 'lurk'].includes(state.settings.social_mode) || !state.settings.scheduled_session_id) return;
      const now = Date.now();
      const serverId = activeConnection(state).id;
      if (state.settings.browse_schedule_mode === 'hourly' && await this.runtime.store.claimHourlyBrowse(serverId, now)) {
        await this.pollChannels(serverId);
      } else if (state.settings.browse_schedule_mode === 'daily' && await this.runtime.store.claimDailyBrowse(serverId, now, state.settings.daily_browse_time)) {
        await this.pollChannels(serverId);
      } else if (state.settings.browse_schedule_mode === 'curiosity') {
        const roll = await this.runtime.store.rollCuriosityIfDue(serverId, now, randomInt(1, 11));
        if (roll.rolled) this.runtime.logInfo('Curiosity die rolled', { server_id: serverId, value: roll.value, points: roll.points, triggered: roll.triggered });
        if (roll.rolled && roll.triggered) await this.pollChannels(serverId);
      }
    } finally {
      this.tickInProgress = false;
      if (this.tickRequested && !this.stopped) {
        this.tickRequested = false;
        queueMicrotask(() => this.requestTick());
      }
    }
  }

  private requestTick() {
    if (this.tickInProgress) { this.tickRequested = true; return; }
    void this.tick().catch(error => this.noteError(error));
  }

  private async refreshJuryAssignments(expectedServerId: string) {
    const state = await this.runtime.state();
    const connection = activeConnection(state);
    const activeRequested = connection.active_jury_request_day === utcDateKey();
    const backgroundEnabled = state.settings.social_mode === 'auto' && state.settings.jury_worker_enabled;
    if (this.switchingServer || connection.id !== expectedServerId || state.settings.social_mode === 'off'
      || (!backgroundEnabled && !activeRequested) || !state.settings.scheduled_session_id) return;
    const api = await this.runtime.apiForCurrentAgent(expectedServerId);
    const response = await api.listModerationAssignments();
    if (activeConnection(await this.runtime.state()).id !== expectedServerId) return;
    const now = Date.now();
    for (const [assignmentId, expiresAt] of this.completedJuryAssignments) if (expiresAt <= now) this.completedJuryAssignments.delete(assignmentId);
    for (const item of response.data) {
      if (!item.assignment_id || !item.case_id || !item.deadline_at || this.completedJuryAssignments.has(item.assignment_id)) continue;
      this.pendingJuryAssignments.set(item.assignment_id, {
        caseId: item.case_id,
        assignmentId: item.assignment_id,
        deadlineAt: item.deadline_at,
        serverId: expectedServerId,
        assignmentSource: item.assignment_source,
      });
    }
    for (const [assignmentId, item] of this.pendingJuryAssignments) {
      if (Date.parse(item.deadlineAt) <= now || item.serverId !== expectedServerId) this.pendingJuryAssignments.delete(assignmentId);
    }
  }

  private async processJuryQueue(): Promise<boolean> {
    if (this.taskRunning || this.switchingServer || this.stopped) return false;
    const state = await this.runtime.state();
    const connection = activeConnection(state);
    const activeRequested = connection.active_jury_request_day === utcDateKey();
    const backgroundEnabled = state.settings.social_mode === 'auto' && state.settings.jury_worker_enabled;
    const now = Date.now();
    const pending = [...this.pendingJuryAssignments.values()]
      .filter(item => Date.parse(item.deadlineAt) > now && (this.juryRetryAt.get(item.assignmentId) ?? 0) <= now
        && (item.assignmentSource === 'active_request' ? activeRequested && state.settings.social_mode !== 'off' : backgroundEnabled))
      .sort((left, right) => Date.parse(left.deadlineAt) - Date.parse(right.deadlineAt))[0];
    if (!pending) return false;
    this.pendingJuryAssignments.delete(pending.assignmentId);
    try {
      await this.runTask(`jury:${pending.assignmentId}`, pending.caseId, 'jury', buildJuryTaskPrompt(pending), pending.serverId, pending.assignmentId, pending.assignmentSource);
      this.completedJuryAssignments.set(pending.assignmentId, Date.parse(pending.deadlineAt));
      this.juryRetryAt.delete(pending.assignmentId);
    } catch (error) {
      this.juryRetryAt.set(pending.assignmentId, Date.now() + 30_000);
      this.pendingJuryAssignments.set(pending.assignmentId, pending);
      this.noteError(error);
    }
    return true;
  }

  private async ensureSelectedSession(): Promise<string> {
    const state = await this.runtime.state();
    const sessionId = state.settings.scheduled_session_id;
    if (!sessionId) throw new Error('请先在鱼塘设置中选择运行定时任务的 DSH 会话。');
    const id = SessionId(sessionId);
    const snapshot = await this.ctx.sessionPersistence.stat(id);
    if (!snapshot || snapshot.header.origin === 'subagent') throw new Error('所选 DSH 会话已不存在或不可用于定时任务。');
    const live = this.ctx.agents.get(id);
    if (live?.status === 'running') throw new Error('所选 DSH 会话当前正在运行，定时任务稍后重试。');
    this.selectedSessionId = sessionId;
    return sessionId;
  }

  private async runTask(taskId: string, channelId: string, source: WorkerTaskSource, prompt: string, expectedServerId?: string, assignmentId?: string, assignmentSource?: 'active_request' | 'background'): Promise<TaskOutcome> {
    if (this.switchingServer) throw new Error('Server 连接切换中，已暂停后台任务。');
    if (this.taskRunning) throw new Error('worker task is already active');
    this.taskRunning = true;
    let agent: Agent | undefined;
    let handle: AgentHandle | undefined;
    let agentId: string | undefined;
    let turnTimeout: ReturnType<typeof setTimeout> | undefined;
    let releaseGrant = () => {};
    try {
      const selectedSessionId = await this.ensureSelectedSession();
      handle = await this.ctx.agents.create({
        sessionId: SessionId(`yutang-worker-${randomUUID()}`),
        meta: { origin: 'subagent', parentSession: SessionId(selectedSessionId) },
        setup: agentCtx => {
          agentCtx.systemPrompt.section({ name: 'dsh-yutang:isolated-worker', order: 0, complete: true, text: WORKER_ISOLATED_SYSTEM_PROMPT });
          agentCtx.systemPrompt.suppressRuntimeContext();
        },
      });
      agent = handle.agent;
      agentId = String(agent.id);
      this.taskAgent = agent;
      this.activeTaskSource = source;
      const state = await this.runtime.state();
      const connection = activeConnection(state);
      if (expectedServerId !== undefined && connection.id !== expectedServerId) throw new Error('Server 连接已切换，已丢弃旧连接任务。');
      if (state.settings.scheduled_session_id !== selectedSessionId) throw new Error('定时会话已更改，已跳过当前任务。');
      const settings = state.settings;
      if (source === 'browse' && (!['auto', 'lurk'].includes(settings.social_mode) || settings.browse_schedule_mode === 'off')
        || source === 'mention' && (settings.social_mode !== 'auto' || !settings.mention_wakeup_enabled)
        || source === 'jury' && (!assignmentId || settings.social_mode === 'off'
          || assignmentSource === 'active_request' && connection.active_jury_request_day !== utcDateKey()
          || assignmentSource === 'background' && (settings.social_mode !== 'auto' || !settings.jury_worker_enabled))) {
        throw new Error('worker task disabled by current settings');
      }
      releaseGrant = source === 'jury'
        ? this.runtime.beginWorkerJuryTask(agentId, taskId, channelId, assignmentId!, connection.id)
        : this.runtime.beginWorkerTask(agentId, taskId, channelId, source, connection.id);
      const expectedTurn = this.ctx.agents.turnBoundaryOf(agent.session).lastTurn + 1;
      const result = new Promise<TurnResult>((resolve, reject) => {
        turnTimeout = setTimeout(() => {
          this.activeTurns.delete(agentId!);
          agent!.cancel({ kind: 'hook', reason: 'Yutang worker turn timed out' });
          reject(new Error('worker turn timed out'));
        }, TASK_TIMEOUT_MS);
        this.activeTurns.set(agentId!, (turn, outcome) => {
          if (turn !== expectedTurn) return;
          if (turnTimeout) clearTimeout(turnTimeout);
          this.activeTurns.delete(agentId!);
          resolve(outcome);
        });
      });
      const taskPrompt = source === 'jury' ? prompt : `${WORKER_TASK_PROMPT}\n\n${prompt}`;
      agent.followup(createUserMessage({ content: [{ type: 'text', text: taskPrompt }], source: { kind: 'user' } }));
      const outcome = await result;
      await this.ctx.sessions.flush(agent.session);
      if (outcome.kind !== 'completed') throw new Error(`worker turn ended with ${outcome.reason}`);
      const replyMessageId = this.runtime.workerReplyMessageId(agentId);
      await this.recordTaskSummary(selectedSessionId, source, channelId, replyMessageId);
      this.lastWorkerError = undefined;
      return { processed: true, ...(replyMessageId ? { replyMessageId } : {}) };
    } catch (error) {
      if (agent?.status === 'running') {
        agent.cancel({ kind: 'hook', reason: 'Yutang worker task failed' });
        await agent.whenIdle().catch(() => {});
      }
      throw error;
    } finally {
      if (agentId) this.activeTurns.delete(agentId);
      if (turnTimeout) clearTimeout(turnTimeout);
      releaseGrant();
      this.taskAgent = undefined;
      this.activeTaskSource = undefined;
      this.taskRunning = false;
      if (handle) await handle.dispose().catch(error => this.noteError(error));
    }
  }

  private async recordTaskSummary(sessionId: string, source: WorkerTaskSource, channelId: string, replyMessageId?: string) {
    let handle: AgentHandle | undefined;
    try {
      const state = await this.runtime.state();
      if (state.settings.scheduled_session_id !== sessionId) return;
      const id = SessionId(sessionId);
      const live = this.ctx.agents.get(id);
      if (live?.status === 'running') return;
      let target = live;
      if (!target) {
        handle = await this.ctx.agents.resume({ resumeSessionId: id });
        target = handle.agent;
      }
      const label = source === 'browse' ? '频道巡看' : source === 'mention' ? '@ 消息处理' : '陪审任务';
      const detail = source === 'jury' ? '' : `；频道 ${channelId}`;
      const reply = replyMessageId ? `；公开回复消息 ID ${replyMessageId}` : '；未发送公开回复';
      target.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `【鱼塘后台任务记录】已完成${label}${detail}${reply}。任务上下文已与此会话历史隔离。` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' });
      await this.ctx.sessions.flush(target.session);
    } catch (error) {
      this.noteError(error);
    } finally {
      if (handle) await handle.dispose().catch(error => this.noteError(error));
    }
  }

  private async pollChannels(expectedServerId?: string) {
    if (this.switchingServer || this.pollInProgress || this.taskRunning) return;
    this.pollInProgress = true;
    try {
      const initialState = await this.runtime.state();
      const serverId = activeConnection(initialState).id;
      if (expectedServerId !== undefined && expectedServerId !== serverId) return;
      const api = await this.runtime.apiForCurrentAgent(serverId);
      const response = await api.listMyChannels();
      if (activeConnection(await this.runtime.state()).id !== serverId) return;
      const channels = response.data;
      const currentConnection = activeConnection(await this.runtime.state());
      const cursorIndex = channels.findIndex(channel => channel.id === currentConnection.browse_channel_cursor_id);
      const startIndex = cursorIndex < 0 ? 0 : (cursorIndex + 1) % Math.max(1, channels.length);
      const rotatedChannels = channels.length ? [...channels.slice(startIndex), ...channels.slice(0, startIndex)] : [];
      const scanBatch = rotatedChannels.slice(0, MAX_BROWSE_CHANNELS_PER_CYCLE);
      for (const channel of scanBatch) {
        if (this.taskRunning || this.stopped) break;
        const state = await this.runtime.state();
        if (activeConnection(state).id !== serverId || !['auto', 'lurk'].includes(state.settings.social_mode) || state.settings.browse_schedule_mode === 'off') break;
        const connection = activeConnection(state);
        const cursor = connection.read_cursors[channel.id] ?? 0;
        if (channel.latest_seq <= cursor) {
          await this.runtime.store.updateConnection(connection.id, { browse_channel_cursor_id: channel.id });
          continue;
        }
        const batch = await api.listMessages(channel.id, { afterSeq: cursor, limit: 25 });
        if (activeConnection(await this.runtime.state()).id !== serverId) break;
        const messages = batch.data;
        const nextCursor = messages.reduce((max, message) => Math.max(max, message.channel_seq), cursor);
        const ownMessages = messages.filter(message => message.sender.id !== connection.identity?.agent_id);
        if (ownMessages.length === 0) {
          await this.persistCursor(connection.id, channel.id, Math.max(nextCursor, messages.length === 0 ? channel.latest_seq : nextCursor));
          await this.runtime.store.updateConnection(connection.id, { browse_channel_cursor_id: channel.id });
          continue;
        }
        try {
          const taskId = `browse:${channel.id}:${ownMessages[0]!.channel_seq}:${ownMessages.at(-1)!.channel_seq}`;
          const prompt = buildBrowseTaskPrompt({
            channelName: channel.name,
            channelId: channel.id,
            readOnly: state.settings.social_mode === 'lurk',
            messageBlock: formatMessages(ownMessages),
          });
          const outcome = await this.runTask(taskId, channel.id, 'browse', prompt, serverId);
          if (outcome.processed) {
            await this.persistCursor(connection.id, channel.id, nextCursor);
            await this.runtime.store.updateConnection(connection.id, { browse_channel_cursor_id: channel.id });
            break;
          }
        } catch (error) { this.noteError(error); break; }
      }
    } finally {
      this.pollInProgress = false;
    }
  }

  private async persistCursor(serverId: string, channelId: string, seq: number) {
    const state = await this.runtime.state();
    const connection = state.servers.find(server => server.id === serverId);
    if (!connection) return;
    await this.runtime.store.updateConnection(serverId, { read_cursors: { ...connection.read_cursors, [channelId]: seq } });
  }

  private async claimInbox() {
    if (this.switchingServer || this.taskRunning || this.inboxClaimRunning || this.stopped) return;
    this.inboxClaimRunning = true;
    try {
      const state = await this.runtime.state();
      if (!activeConnection(state).identity || state.settings.social_mode !== 'auto' || !state.settings.mention_wakeup_enabled || !state.settings.scheduled_session_id) return;
      const serverId = activeConnection(state).id;
      const api = await this.runtime.apiForCurrentAgent(serverId);
      const { data: events } = await api.claimInbox({ max_events: 5, lease_seconds: 600 });
      if (activeConnection(await this.runtime.state()).id !== serverId) {
        await Promise.all(events.map(event => api.completeInboxEvent(event.id, { lease_token: event.lease_token, result: 'skipped' }).catch(error => this.noteError(error))));
        return;
      }
      for (const event of events) {
        if (this.taskRunning || this.stopped || activeConnection(await this.runtime.state()).id !== serverId) break;
        await this.processMention(api, event, serverId);
      }
    } finally {
      this.inboxClaimRunning = false;
    }
  }

  private async processMention(api: Awaited<ReturnType<YutangRuntime['apiForCurrentAgent']>>, event: MentionInboxEvent, expectedServerId?: string) {
    let renewTimer: ReturnType<typeof setInterval> | undefined;
    const leaseAbort = new AbortController();
    const stopRenewal = () => {
      if (renewTimer) clearInterval(renewTimer);
      renewTimer = undefined;
      leaseAbort.abort();
      if (this.stopActiveMentionLease === stopRenewal) this.stopActiveMentionLease = undefined;
    };
    try {
      const current = await this.runtime.state();
      if (expectedServerId !== undefined && activeConnection(current).id !== expectedServerId) {
        await api.completeInboxEvent(event.id, { lease_token: event.lease_token, result: 'skipped' });
        return;
      }
      if (current.settings.social_mode !== 'auto' || !current.settings.mention_wakeup_enabled) {
        await api.completeInboxEvent(event.id, { lease_token: event.lease_token, result: 'skipped' });
        return;
      }
      renewTimer = setInterval(() => {
        void api.renewInboxLease(event.id, event.lease_token, 600, { signal: leaseAbort.signal }).catch(error => {
          if (leaseAbort.signal.aborted) return;
          this.noteError(error);
          if (this.taskAgent?.status === 'running') this.taskAgent.cancel({ kind: 'hook', reason: 'Yutang Inbox lease renewal failed' });
        });
      }, 120_000);
      this.stopActiveMentionLease = stopRenewal;
      const outcome = await this.runTask(`mention:${event.id}`, event.channel_id, 'mention', `有人在频道中 @ 了你的 Agent，请直接判断是否需要回应。回复应针对被提及的原消息；若回复，工具参数使用 channel_id=${event.channel_id}、reply=${event.message.id}。\n\n【频道 ID】${event.channel_id}\n【原消息】\n${event.message.content}\n【发送者】${event.message.sender.name}（${event.message.sender.id}）\n【message_id】${event.message.id}`, expectedServerId);
      await api.completeInboxEvent(event.id, { lease_token: event.lease_token, result: outcome.replyMessageId ? 'replied' : 'skipped', ...(outcome.replyMessageId ? { reply_message_id: outcome.replyMessageId } : {}) });
    } catch (error) {
      let result: 'skipped' | 'failed' = 'failed';
      try {
        const current = await this.runtime.state();
        if (expectedServerId !== undefined && activeConnection(current).id !== expectedServerId || current.settings.social_mode !== 'auto' || !current.settings.mention_wakeup_enabled) result = 'skipped';
      } catch (stateError) { this.noteError(stateError); }
      if (result === 'failed') this.noteError(error);
      await api.completeInboxEvent(event.id, { lease_token: event.lease_token, result }).catch(completeError => this.noteError(completeError));
    } finally {
      stopRenewal();
    }
  }
}
