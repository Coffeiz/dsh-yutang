import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeTurnLockAllowlist, type TurnLockAllowedTool } from '../security/tool-lock.js';

export type SocialMode = 'auto' | 'lurk' | 'manual' | 'off';
export type BrowseScheduleMode = 'off' | 'hourly' | 'daily' | 'curiosity';
export const CURIOSITY_THRESHOLD = 30;
const HOUR_MS = 60 * 60 * 1000;
export interface IdentityState {
  owner_id: string;
  agent_id: string;
  display_name: string;
  public_key: string;
  scopes: string[];
  avatar_url?: string | null;
}
export interface PendingRegistrationState {
  owner_id?: string;
  server_url: string;
  display_name: string;
  public_key: string;
}
export interface ServerConnectionState {
  id: string;
  kind: 'official' | 'custom';
  name: string;
  server_url: string | null;
  identity: IdentityState | null;
  pending_registration: PendingRegistrationState | null;
  worker_session_id: string | null;
  read_cursors: Record<string, number>;
  browse_channel_cursor_id: string | null;
  browse_next_run_at: number | null;
  last_daily_browse_date: string | null;
  curiosity_points: number;
  curiosity_next_roll_at: number | null;
  curiosity_last_roll_at: number | null;
  curiosity_last_roll_value: number | null;
}
export interface PluginSettings {
  social_mode: SocialMode;
  system_prompt_enabled: boolean;
  agent_personality: string;
  knowledge_context: string;
  auto_browse_enabled: boolean;
  poll_interval_minutes: 5 | 10 | 30 | 60;
  mention_wakeup_enabled: boolean;
  jury_worker_enabled: boolean;
  channel_creation_enabled: boolean;
  tool_lock_allowed_tools: TurnLockAllowedTool[];
  browse_schedule_mode: BrowseScheduleMode;
  daily_browse_time: string;
  scheduled_session_id: string | null;
}
export interface YutangState {
  version: 5;
  active_server_id: string;
  last_yutang_session_id: string | null;
  task_session_selection_set: boolean;
  servers: ServerConnectionState[];
  settings: PluginSettings;
  turn_tool_locks: Record<string, number>;
}

export const defaultSettings: PluginSettings = {
  social_mode: 'auto', system_prompt_enabled: false, agent_personality: '', knowledge_context: '',
  auto_browse_enabled: false, poll_interval_minutes: 10, mention_wakeup_enabled: false,
  jury_worker_enabled: true,
  channel_creation_enabled: false, tool_lock_allowed_tools: [],
  browse_schedule_mode: 'off', daily_browse_time: '09:00', scheduled_session_id: null,
};

const validTimestamp = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
const validDateKey = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : null;
const localDateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const validCursors = (value: unknown): Record<string, number> => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isSafeInteger(entry[1]) && entry[1] >= 0))
  : {};
const validTurnToolLocks = (value: unknown): Record<string, number> => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, number] => Boolean(entry[0]) && typeof entry[1] === 'number' && Number.isSafeInteger(entry[1]) && entry[1] > 0))
  : {};
const cleanIdentity = (value: unknown): IdentityState | null => {
  if (!value || typeof value !== 'object') return null;
  const item = value as IdentityState & { private_key?: unknown; access_token?: unknown; access_token_expires_at?: unknown };
  if (typeof item.agent_id !== 'string' || typeof item.owner_id !== 'string' || typeof item.public_key !== 'string') return null;
  return { owner_id: item.owner_id, agent_id: item.agent_id, display_name: item.display_name, public_key: item.public_key, scopes: Array.isArray(item.scopes) ? item.scopes.filter((scope): scope is string => typeof scope === 'string') : [], ...(item.avatar_url !== undefined ? { avatar_url: item.avatar_url } : {}) };
};
const connectionIdFor = (serverUrl: string) => `custom-${createHash('sha256').update(serverUrl).digest('hex').slice(0, 20)}`;
const emptyConnection = (id: string, kind: ServerConnectionState['kind'], name: string, serverUrl: string | null): ServerConnectionState => ({ id, kind, name, server_url: serverUrl, identity: null, pending_registration: null, worker_session_id: null, read_cursors: {}, browse_channel_cursor_id: null, browse_next_run_at: null, last_daily_browse_date: null, curiosity_points: 0, curiosity_next_roll_at: null, curiosity_last_roll_at: null, curiosity_last_roll_value: null });
const normalizeConnection = (value: unknown): ServerConnectionState | null => {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<ServerConnectionState>;
  if (typeof item.id !== 'string' || !item.id || (item.kind !== 'custom' && item.kind !== 'official')) return null;
  const url = typeof item.server_url === 'string' ? item.server_url : null;
  return {
    id: item.kind === 'official' ? 'official' : item.id,
    kind: item.kind,
    name: typeof item.name === 'string' ? item.name : item.kind === 'official' ? '官方服务器' : '自定义服务器',
    server_url: url,
    identity: cleanIdentity(item.identity),
    pending_registration: item.pending_registration && typeof item.pending_registration === 'object' ? item.pending_registration as PendingRegistrationState : null,
    worker_session_id: typeof item.worker_session_id === 'string' ? item.worker_session_id : null,
    read_cursors: validCursors(item.read_cursors),
    browse_channel_cursor_id: typeof item.browse_channel_cursor_id === 'string' ? item.browse_channel_cursor_id : null,
    browse_next_run_at: validTimestamp(item.browse_next_run_at),
    last_daily_browse_date: validDateKey(item.last_daily_browse_date),
    curiosity_points: typeof item.curiosity_points === 'number' && Number.isSafeInteger(item.curiosity_points) ? Math.max(0, Math.min(CURIOSITY_THRESHOLD - 1, item.curiosity_points)) : 0,
    curiosity_next_roll_at: validTimestamp(item.curiosity_next_roll_at),
    curiosity_last_roll_at: validTimestamp(item.curiosity_last_roll_at),
    curiosity_last_roll_value: typeof item.curiosity_last_roll_value === 'number' && Number.isSafeInteger(item.curiosity_last_roll_value) && item.curiosity_last_roll_value >= 1 && item.curiosity_last_roll_value <= 10 ? item.curiosity_last_roll_value : null,
  };
};

export const activeConnection = (state: YutangState): ServerConnectionState => state.servers.find(server => server.id === state.active_server_id) ?? state.servers[0]!;

export class StateStore {
  readonly path: string;
  private state: YutangState | undefined;
  private legacyIdentityPrivateKey: string | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  constructor(dataDir: string, private readonly defaultServerUrl: string, private readonly officialServerUrl?: string) { this.path = join(dataDir, 'state.json'); }

  async load(): Promise<YutangState> {
    if (this.state) return this.state;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, unknown>;
      this.state = parsed.version === 5 && Array.isArray(parsed.servers) ? this.fromV5(parsed)
        : parsed.version === 4 && Array.isArray(parsed.servers) ? this.fromV4(parsed)
          : this.migrateLegacy(parsed);
      if (parsed.version !== 5) await this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('dsh-yutang local state is unreadable');
      this.state = this.initialState();
      await this.save();
    }
    return this.state;
  }

  private settingsFrom(value: unknown): PluginSettings {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const socialMode = ['auto', 'lurk', 'manual', 'off'].includes(String(input.social_mode)) ? input.social_mode as SocialMode : defaultSettings.social_mode;
    const pollInterval = typeof input.poll_interval_minutes === 'number' && [5, 10, 30, 60].includes(input.poll_interval_minutes) ? input.poll_interval_minutes as PluginSettings['poll_interval_minutes'] : defaultSettings.poll_interval_minutes;
    const browseScheduleMode = ['off', 'hourly', 'daily', 'curiosity'].includes(String(input.browse_schedule_mode))
      ? input.browse_schedule_mode as BrowseScheduleMode
      : input.auto_browse_enabled === true ? 'hourly' : defaultSettings.browse_schedule_mode;
    const dailyBrowseTime = typeof input.daily_browse_time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(input.daily_browse_time) ? input.daily_browse_time : defaultSettings.daily_browse_time;
    const limitedText = (key: 'agent_personality' | 'knowledge_context', max: number) => typeof input[key] === 'string' && input[key].length <= max ? input[key] as string : defaultSettings[key];
    const boolean = (key: keyof PluginSettings) => typeof input[key] === 'boolean' ? input[key] as boolean : defaultSettings[key] as boolean;
    return {
      social_mode: socialMode,
      poll_interval_minutes: pollInterval,
      agent_personality: limitedText('agent_personality', 12_000),
      knowledge_context: limitedText('knowledge_context', 20_000),
      system_prompt_enabled: boolean('system_prompt_enabled'),
      auto_browse_enabled: browseScheduleMode !== 'off',
      mention_wakeup_enabled: boolean('mention_wakeup_enabled'),
      jury_worker_enabled: boolean('jury_worker_enabled'),
      channel_creation_enabled: boolean('channel_creation_enabled'),
      tool_lock_allowed_tools: normalizeTurnLockAllowlist(input.tool_lock_allowed_tools),
      browse_schedule_mode: browseScheduleMode,
      daily_browse_time: dailyBrowseTime,
      scheduled_session_id: typeof input.scheduled_session_id === 'string' && input.scheduled_session_id.length <= 160 ? input.scheduled_session_id : null,
    };
  }

  private fromV4(parsed: Record<string, unknown>): YutangState {
    const servers = (parsed.servers as unknown[]).map(normalizeConnection).filter((server): server is ServerConnectionState => server !== null);
    this.ensurePermanentServers(servers);
    const selected = typeof parsed.active_server_id === 'string' && servers.some(server => server.id === parsed.active_server_id)
      ? parsed.active_server_id
      : servers.find(server => server.kind === 'custom' && server.server_url)?.id ?? 'official';
    const settings = this.settingsFrom(parsed.settings);
    return { version: 5, active_server_id: selected, last_yutang_session_id: null, task_session_selection_set: Boolean(settings.scheduled_session_id), servers, settings, turn_tool_locks: validTurnToolLocks(parsed.turn_tool_locks) };
  }

  private fromV5(parsed: Record<string, unknown>): YutangState {
    const state = this.fromV4(parsed);
    state.last_yutang_session_id = typeof parsed.last_yutang_session_id === 'string'
      && parsed.last_yutang_session_id.length > 0 && parsed.last_yutang_session_id.length <= 160
      ? parsed.last_yutang_session_id
      : null;
    state.task_session_selection_set = typeof parsed.task_session_selection_set === 'boolean'
      ? parsed.task_session_selection_set
      : Boolean(state.settings.scheduled_session_id);
    return state;
  }

  private migrateLegacy(parsed: Record<string, unknown>): YutangState {
    const legacyIdentity = parsed.identity as (IdentityState & { private_key?: unknown }) | null;
    if (typeof legacyIdentity?.private_key === 'string') this.legacyIdentityPrivateKey = legacyIdentity.private_key;
    const url = typeof parsed.server_url === 'string' ? parsed.server_url : this.defaultServerUrl;
    const connection = emptyConnection(connectionIdFor(url), 'custom', '自定义服务器', url);
    connection.identity = cleanIdentity(legacyIdentity);
    connection.pending_registration = parsed.pending_registration && typeof parsed.pending_registration === 'object' ? parsed.pending_registration as PendingRegistrationState : null;
    connection.worker_session_id = typeof parsed.worker_session_id === 'string' ? parsed.worker_session_id : null;
    connection.read_cursors = validCursors(parsed.read_cursors);
    const servers = [connection];
    this.ensurePermanentServers(servers);
    const settings = this.settingsFrom(parsed.settings);
    return { version: 5, active_server_id: connection.id, last_yutang_session_id: null, task_session_selection_set: Boolean(settings.scheduled_session_id), servers, settings, turn_tool_locks: {} };
  }

  private initialState(): YutangState {
    if (this.officialServerUrl) {
      const official = emptyConnection('official', 'official', '官方服务器', this.officialServerUrl);
      return { version: 5, active_server_id: official.id, last_yutang_session_id: null, task_session_selection_set: false, servers: [official], settings: { ...defaultSettings }, turn_tool_locks: {} };
    }
    const connection = emptyConnection(connectionIdFor(this.defaultServerUrl), 'custom', '自定义服务器', this.defaultServerUrl);
    const servers = [connection];
    this.ensurePermanentServers(servers);
    return { version: 5, active_server_id: connection.id, last_yutang_session_id: null, task_session_selection_set: false, servers, settings: { ...defaultSettings }, turn_tool_locks: {} };
  }

  private ensurePermanentServers(servers: ServerConnectionState[]) {
    const officialIndex = servers.findIndex(server => server.id === 'official');
    const official = officialIndex >= 0 ? servers[officialIndex] : undefined;
    if (official) {
      official.kind = 'official';
      official.name = '官方服务器';
      official.server_url = this.officialServerUrl ?? null;
      if (officialIndex !== 0) {
        servers.splice(officialIndex, 1);
        servers.unshift(official);
      }
    } else servers.unshift(emptyConnection('official', 'official', '官方服务器', this.officialServerUrl ?? null));
  }

  takeLegacyIdentityPrivateKey() {
    const privateKey = this.legacyIdentityPrivateKey;
    this.legacyIdentityPrivateKey = undefined;
    return privateKey;
  }

  async update(patch: Partial<Pick<ServerConnectionState, 'server_url' | 'identity' | 'pending_registration' | 'worker_session_id' | 'read_cursors' | 'browse_channel_cursor_id' | 'browse_next_run_at' | 'last_daily_browse_date' | 'curiosity_points' | 'curiosity_next_roll_at' | 'curiosity_last_roll_at' | 'curiosity_last_roll_value'>> & { settings?: Partial<PluginSettings>; task_session_selection_set?: boolean }): Promise<YutangState> {
    const state = await this.load();
    const active = activeConnection(state);
    Object.assign(active, Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'settings' && key !== 'task_session_selection_set')));
    if (patch.settings) {
      state.settings = { ...state.settings, ...patch.settings };
    }
    if (patch.task_session_selection_set !== undefined) state.task_session_selection_set = patch.task_session_selection_set;
    else if (patch.settings && Object.hasOwn(patch.settings, 'scheduled_session_id')) state.task_session_selection_set = true;
    await this.save();
    return state;
  }

  async updateConnection(id: string, patch: Partial<Pick<ServerConnectionState, 'server_url' | 'identity' | 'pending_registration' | 'worker_session_id' | 'read_cursors' | 'browse_channel_cursor_id' | 'browse_next_run_at' | 'last_daily_browse_date' | 'curiosity_points' | 'curiosity_next_roll_at' | 'curiosity_last_roll_at' | 'curiosity_last_roll_value'>>): Promise<YutangState> {
    const state = await this.load();
    const connection = state.servers.find(server => server.id === id);
    if (!connection) throw new Error('找不到此 Server 连接。');
    Object.assign(connection, patch);
    await this.save();
    return state;
  }

  async rollCuriosityIfDue(serverId: string, now: number, value: number) {
    const state = await this.load();
    const connection = state.servers.find(server => server.id === serverId);
    if (!connection) throw new Error('找不到此 Server 连接。');
    if (connection.curiosity_next_roll_at === null) {
      connection.curiosity_next_roll_at = now + HOUR_MS;
      await this.save();
      return { rolled: false as const, points: connection.curiosity_points, nextRollAt: connection.curiosity_next_roll_at };
    }
    if (now < connection.curiosity_next_roll_at) return { rolled: false as const, points: connection.curiosity_points, nextRollAt: connection.curiosity_next_roll_at };
    if (!Number.isSafeInteger(value) || value < 1 || value > 10) throw new Error('骰子结果必须是 1–10。');
    const sum = connection.curiosity_points + value;
    const triggered = sum >= CURIOSITY_THRESHOLD;
    connection.curiosity_points = triggered ? sum - CURIOSITY_THRESHOLD : sum;
    connection.curiosity_last_roll_at = now;
    connection.curiosity_last_roll_value = value;
    connection.curiosity_next_roll_at = now + HOUR_MS;
    await this.save();
    return { rolled: true as const, value, points: connection.curiosity_points, triggered, nextRollAt: connection.curiosity_next_roll_at };
  }

  async claimHourlyBrowse(serverId: string, now: number) {
    const state = await this.load();
    const connection = state.servers.find(server => server.id === serverId);
    if (!connection) throw new Error('找不到此 Server 连接。');
    if (connection.browse_next_run_at === null) {
      connection.browse_next_run_at = now + HOUR_MS;
      await this.save();
      return false;
    }
    if (now < connection.browse_next_run_at) return false;
    connection.browse_next_run_at = now + HOUR_MS;
    await this.save();
    return true;
  }

  async claimDailyBrowse(serverId: string, now: number, dailyTime: string) {
    const state = await this.load();
    const connection = state.servers.find(server => server.id === serverId);
    if (!connection) throw new Error('找不到此 Server 连接。');
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(dailyTime)) throw new Error('每日巡看时间无效。');
    const date = new Date(now);
    const dateKey = localDateKey(date);
    const [hours, minutes] = dailyTime.split(':').map(Number);
    if (date.getHours() * 60 + date.getMinutes() < hours! * 60 + minutes! || connection.last_daily_browse_date === dateKey) return false;
    connection.last_daily_browse_date = dateKey;
    await this.save();
    return true;
  }

  async updateTurnToolLock(agentId: string, turn: number): Promise<void> {
    if (!agentId || !Number.isSafeInteger(turn) || turn < 1) throw new Error('无效的工具锁轮次。');
    const state = await this.load();
    state.turn_tool_locks[agentId] = turn;
    await this.save();
  }

  async rememberYutangSession(sessionId: string): Promise<{ selectedByDefault: boolean }> {
    if (!sessionId || sessionId.length > 160) throw new Error('无效的 DSH Session ID。');
    const state = await this.load();
    const selectedByDefault = !state.settings.scheduled_session_id && !state.task_session_selection_set;
    if (state.last_yutang_session_id === sessionId && !selectedByDefault) return { selectedByDefault: false };
    state.last_yutang_session_id = sessionId;
    if (selectedByDefault && !state.task_session_selection_set) {
      state.settings.scheduled_session_id = sessionId;
      state.task_session_selection_set = true;
    }
    await this.save();
    return { selectedByDefault };
  }

  async addCustomServer(name: string, serverUrl: string): Promise<ServerConnectionState> {
    const state = await this.load();
    if (state.servers.some(server => server.server_url === serverUrl)) throw new Error('此 Server 已经添加。');
    const server = emptyConnection(randomUUID(), 'custom', name || new URL(serverUrl).host, serverUrl);
    state.servers.push(server);
    await this.save();
    return server;
  }

  async selectServer(id: string): Promise<ServerConnectionState> {
    const state = await this.load();
    const server = state.servers.find(item => item.id === id);
    if (!server) throw new Error('找不到此 Server 连接。');
    if (!server.server_url) throw new Error('官方 Server 地址尚未由部署配置提供。');
    state.active_server_id = server.id;
    await this.save();
    return server;
  }

  async removeServer(id: string): Promise<void> {
    const state = await this.load();
    const server = state.servers.find(item => item.id === id);
    if (!server || server.kind === 'official') throw new Error('官方服务器是固定选项，不能删除。');
    if (server.identity) throw new Error('此连接已注册 Agent，请先注销并同步删除服务端身份。');
    state.servers = state.servers.filter(item => item.id !== id);
    if (state.active_server_id === id) state.active_server_id = state.servers.find(item => item.server_url)?.id ?? 'official';
    await this.save();
  }

  async forgetUnregisteredServer(id: string): Promise<void> {
    const state = await this.load();
    const server = state.servers.find(item => item.id === id);
    if (!server || !server.identity) throw new Error('找不到已注册的 Server 身份。');
    if (server.kind === 'official') {
      server.identity = null;
      server.pending_registration = null;
      server.worker_session_id = null;
      server.read_cursors = {};
    } else {
      state.servers = state.servers.filter(item => item.id !== id);
      if (state.active_server_id === id) state.active_server_id = state.servers.find(item => item.server_url)?.id ?? 'official';
    }
    await this.save();
  }

  private async save(): Promise<void> {
    const state = this.state!;
    const write = this.writeQueue.then(async () => {
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        await rename(temp, this.path);
        await chmod(this.path, 0o600);
      } catch (error) { await rm(temp, { force: true }); throw error; }
    });
    this.writeQueue = write.catch(() => {});
    await write;
  }
}
