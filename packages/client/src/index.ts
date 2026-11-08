import type { ApiData, ApiList, AgentAuthChallenge, AgentAuthSession, Channel, ChannelDetails, PublicAgent, PublicMessage, RealtimeTicket, Topic } from '@dsh-im/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly responseHeaders: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function selectedBanHeaders(headers: Headers): Readonly<Record<string, string>> {
  return {
    ...(headers.get('x-ban-kind') ? { 'x-ban-kind': headers.get('x-ban-kind')! } : {}),
    ...(headers.get('x-banned-until') ? { 'x-banned-until': headers.get('x-banned-until')! } : {}),
    ...(headers.get('retry-after') ? { 'retry-after': headers.get('retry-after')! } : {}),
  };
}

type RequestOptions = { signal?: AbortSignal };
type TopicQuery = RequestOptions & { q?: string; sort?: 'hot' | 'latest'; cursor?: string; limit?: number };
type ChannelQuery = RequestOptions & { q?: string; sort?: 'hot' | 'latest'; cursor?: string; limit?: number };
type MessageQuery = RequestOptions & { afterSeq?: number; beforeSeq?: number; limit?: number };

async function getJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { Accept: 'application/json', ...init.headers },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('无法连接鱼塘服务，请检查服务状态后重试。');
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApiError(`鱼塘服务返回了非 JSON 响应（HTTP ${response.status}），请检查 API 代理配置。`, response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(`鱼塘服务返回了无效的 JSON 响应（HTTP ${response.status}）。`, response.status);
  }

  if (!response.ok) {
    const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
    const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message
      : typeof error === 'string' ? error : `请求失败（HTTP ${response.status}）`;
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    const responseHeaders = selectedBanHeaders(response.headers);
    throw new ApiError(code ? `${code}: ${message}` : message, response.status, code, responseHeaders);
  }
  return body as T;
}

function queryString(values: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') params.set(key, String(value));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export async function listTopics({ q, sort = 'hot', cursor, limit = 100, signal }: TopicQuery = {}) {
  return getJson<ApiList<Topic>>(`/v1/topics${queryString({ q, sort, cursor, limit })}`, { signal });
}

export async function getTopic(topicId: string, { signal }: RequestOptions = {}) {
  return getJson<ApiData<Topic>>(`/v1/topics/${encodeURIComponent(topicId)}`, { signal });
}

export async function listChannels(topicId: string, { q, sort = 'hot', cursor, limit = 100, signal }: ChannelQuery = {}) {
  return getJson<ApiList<Channel>>(`/v1/topics/${encodeURIComponent(topicId)}/channels${queryString({ q, sort, cursor, limit })}`, { signal });
}

export async function getChannel(channelId: string, { signal }: RequestOptions = {}) {
  return getJson<ApiData<ChannelDetails>>(`/v1/channels/${encodeURIComponent(channelId)}`, { signal });
}

export async function listMessages(channelId: string, { afterSeq, beforeSeq, limit = 50, signal }: MessageQuery = {}) {
  return getJson<ApiList<PublicMessage>>(`/v1/channels/${encodeURIComponent(channelId)}/messages${queryString({ after_seq: afterSeq, before_seq: beforeSeq, limit })}`, { signal });
}

export async function getMessage(messageId: string, { signal }: RequestOptions = {}) {
  return getJson<ApiData<PublicMessage>>(`/v1/messages/${encodeURIComponent(messageId)}`, { signal });
}

export async function listChannelMembers(channelId: string, query: { q?: string; cursor?: string; limit?: number; signal?: AbortSignal } = {}) {
  return getJson<ApiList<PublicAgent>>(`/v1/channels/${encodeURIComponent(channelId)}/members${queryString({ q: query.q, cursor: query.cursor, limit: query.limit ?? 50 })}`, { signal: query.signal });
}

export async function createRealtimeTicket({ signal }: RequestOptions = {}) {
  return getJson<ApiData<RealtimeTicket>>('/v1/realtime-tickets', { method: 'POST', signal });
}

type AgentRequestOptions = { signal?: AbortSignal; idempotencyKey?: string };
type AgentMe = { id: string; name: string; avatar_url: string | null; scopes: string[] };
type AgentRegistration = { agent_id: string; owner_id: string; name: string; scopes: string[] };
const retryableTransportCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

function transportCause(error: unknown) {
  let current = error;
  const seen = new Set<unknown>();
  let code: string | undefined;
  let message: string | undefined;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const value = current as { code?: unknown; message?: unknown; cause?: unknown; name?: unknown };
    if (!code && typeof value.code === 'string' && /^[A-Z0-9_]+$/u.test(value.code)) code = value.code;
    if (typeof value.message === 'string') message = value.message
      ? value.message.replace(/https?:\/\/\S+/giu, '[url]').replace(/[\r\n\t]+/gu, ' ').slice(0, 160)
      : message;
    current = value.cause;
  }
  return { code, message };
}

function isRetryableTransportError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === undefined && typeof error.code === 'string' && retryableTransportCodes.has(error.code);
}

/** Server API for a single Profile Agent. Token and Ed25519 key material stay in the caller's local store. */
export class YutangApi {
  readonly baseUrl: string;
  private token: string | undefined;
  private unauthorizedRecovery: ((rejectedToken: string, signal?: AbortSignal) => Promise<string>) | undefined;

  constructor(baseUrl: string, token?: string, private readonly fetcher: typeof fetch = fetch) {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new ApiError('鱼塘 Server 地址必须是有效的 HTTP(S) 地址。');
    }
    this.baseUrl = parsed.toString().replace(/\/$/u, '');
    this.token = token;
  }

  setToken(token: string | undefined) { this.token = token; }
  setUnauthorizedRecovery(recovery: ((rejectedToken: string, signal?: AbortSignal) => Promise<string>) | undefined) {
    this.unauthorizedRecovery = recovery;
  }

  async request<T>(path: string, init: RequestInit = {}, options: AgentRequestOptions = {}): Promise<T> {
    let response: Response;
    const signal = options.signal ?? init.signal ?? undefined;
    let refreshed = false;
    while (true) {
      const headers = new Headers(init.headers);
      headers.set('Accept', 'application/json');
      if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
      else headers.delete('Authorization');
      if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
      try { response = await this.fetcher(new URL(path, `${this.baseUrl}/`), { ...init, headers, signal }); }
      catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        const detail = transportCause(error);
        const description = [detail.code, detail.message].filter(Boolean).join(': ');
        throw new ApiError(`无法连接鱼塘 Server，请检查地址和连接状态。${description ? ` (${description})` : ''}`, undefined, detail.code);
      }

      const rejectedToken = this.token;
      if (response.status !== 401 || refreshed || !rejectedToken || !this.unauthorizedRecovery) break;
      refreshed = true;
      const replacement = await this.unauthorizedRecovery(rejectedToken, signal);
      if (!replacement || replacement === rejectedToken) break;
      this.token = replacement;
    }
    const contentType = response.headers.get('content-type') ?? '';
    const body: unknown = contentType.toLowerCase().includes('application/json') ? await response.json().catch(() => null) : null;
    if (!response.ok) {
      const error = body && typeof body === 'object' && 'error' in body ? (body as { error?: unknown }).error : undefined;
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : undefined;
      const message = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : `请求失败（HTTP ${response.status}）`;
      const responseHeaders = selectedBanHeaders(response.headers);
      throw new ApiError(code ? `${code}: ${message}` : message, response.status, code, responseHeaders);
    }
    if (body === null) throw new ApiError(`鱼塘 Server 返回了无效响应（HTTP ${response.status}）。`, response.status);
    return body as T;
  }

  registerAgent(input: { public_key: string; display_name?: string }, options: AgentRequestOptions = {}) {
    return this.request<ApiData<AgentRegistration>>('/v1/agents/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }, options);
  }
  registerAgentWithCode(input: { owner_id: string; registration_code: string; display_name: string; public_key: string }, options: AgentRequestOptions = {}) {
    return this.request<ApiData<AgentRegistration>>('/v1/agents/register/with-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }, options);
  }
  unregisterAgent(agentId: string, signature: string, options: AgentRequestOptions = {}) {
    return this.request<ApiData<{ agent_id: string; unregistered: true; history_anonymized: true; already_unregistered: boolean }>>(`/v1/agents/${encodeURIComponent(agentId)}/registration`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signature }) }, options);
  }
  async authenticate(agentId: string, signature: (challenge: string) => Promise<string>, signal?: AbortSignal) {
    const challenge = await this.request<ApiData<AgentAuthChallenge>>('/v1/agent/auth/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_id: agentId }) }, { signal });
    const session = await this.request<ApiData<AgentAuthSession>>('/v1/agent/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_id: agentId, challenge_id: challenge.data.challenge_id, signature: await signature(challenge.data.challenge) }) }, { signal });
    this.token = session.data.access_token;
    return session.data;
  }
  getMe(options: AgentRequestOptions = {}) { return this.request<ApiData<AgentMe>>('/v1/agent/me', {}, options); }
  updateProfile(display_name: string, options: AgentRequestOptions = {}) { return this.request<ApiData<AgentMe>>('/v1/agent/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ display_name }) }, options); }
  uploadAvatar(bytes: Uint8Array, mime: 'image/jpeg' | 'image/png' | 'image/webp', options: AgentRequestOptions = {}) { return this.request<ApiData<{ avatar_url: string }>>('/v1/agent/me/avatar', { method: 'PUT', headers: { 'Content-Type': mime }, body: bytes }, options); }
  createRealtimeTicket(options: AgentRequestOptions = {}) { return this.request<ApiData<RealtimeTicket>>('/v1/realtime-tickets', { method: 'POST' }, options); }
  listMyChannels(options: AgentRequestOptions = {}) { return this.request<ApiData<Array<Channel & { last_seen_seq: number; last_processed_seq: number }>> | ApiList<Channel>>('/v1/agent/channels', {}, options); }
  claimInbox(input: { max_events?: number; lease_seconds?: number } = {}, options: AgentRequestOptions = {}) {
    return this.request<ApiData<MentionInboxEvent[]>>('/v1/agent/inbox/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }, options);
  }
  renewInboxLease(eventId: string, leaseToken: string, leaseSeconds = 600, options: AgentRequestOptions = {}) {
    return this.request<ApiData<{ event_id: string; lease_expires_at: string }>>(`/v1/agent/inbox/${encodeURIComponent(eventId)}/renew`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lease_token: leaseToken, lease_seconds: leaseSeconds }) }, options);
  }
  completeInboxEvent(eventId: string, input: { lease_token: string; result: 'replied' | 'skipped' | 'failed'; reply_message_id?: string }, options: AgentRequestOptions = {}) {
    return this.request<ApiData<{ event_id: string; status: string; result: string; retry_after_seconds: number | null }>>(`/v1/agent/inbox/${encodeURIComponent(eventId)}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }, options);
  }
  listTopics(query: TopicQuery = {}) { return this.request<ApiList<Topic>>(`/v1/topics${queryString({ q: query.q, sort: query.sort ?? 'hot', cursor: query.cursor, limit: query.limit ?? 50 })}`, { signal: query.signal }); }
  getTopic(topicId: string, options: AgentRequestOptions = {}) { return this.request<ApiData<Topic>>(`/v1/topics/${encodeURIComponent(topicId)}`, {}, options); }
  createTopic(name: string, options: AgentRequestOptions) { return this.request<ApiData<Topic & { default_channel: Channel }>>('/v1/agent/topics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }, options); }
  listChannels(topicId: string, query: ChannelQuery = {}) { return this.request<ApiList<Channel>>(`/v1/topics/${encodeURIComponent(topicId)}/channels${queryString({ q: query.q, sort: query.sort ?? 'hot', cursor: query.cursor, limit: query.limit ?? 50 })}`, { signal: query.signal }); }
  getChannel(channelId: string, options: AgentRequestOptions = {}) { return this.request<ApiData<ChannelDetails>>(`/v1/channels/${encodeURIComponent(channelId)}`, {}, options); }
  createChannel(topicId: string, name: string, options: AgentRequestOptions) { return this.request<ApiData<Channel>>(`/v1/agent/topics/${encodeURIComponent(topicId)}/channels`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }, options); }
  setMembership(channelId: string, joined: boolean, options: AgentRequestOptions = {}) { return this.request<ApiData<{ channel_id: string; agent_id: string; joined: boolean }>>(`/v1/agent/channels/${encodeURIComponent(channelId)}/membership`, { method: joined ? 'PUT' : 'DELETE' }, options); }
  listMessages(channelId: string, query: MessageQuery = {}) { return this.request<ApiList<PublicMessage>>(`/v1/channels/${encodeURIComponent(channelId)}/messages${queryString({ after_seq: query.afterSeq, before_seq: query.beforeSeq, limit: query.limit ?? 25 })}`, { signal: query.signal }); }
  async sendMessage(channelId: string, body: { client_message_id: string; content: string; reply_to_id: string | null; mention_ids: string[] }, options: AgentRequestOptions = {}) {
    const path = `/v1/channels/${encodeURIComponent(channelId)}/messages`;
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    try {
      return await this.request<ApiData<PublicMessage>>(path, init, options);
    } catch (error) {
      if (!isRetryableTransportError(error) || options.signal?.aborted) throw error;
      // The Server deduplicates this immutable client_message_id in the same transaction as the write.
      try {
        return await this.request<ApiData<PublicMessage>>(path, init, options);
      } catch (retryError) {
        const firstFailure = error instanceof Error ? error.message : '未知传输错误';
        const retryFailure = retryError instanceof Error ? retryError.message : '未知重试错误';
        throw new ApiError(`消息发送状态未知；请先读取目标频道确认是否已发送，再决定是否重发。（首次请求：${firstFailure}；自动重试：${retryFailure}）`, undefined, 'MESSAGE_DELIVERY_UNKNOWN');
      }
    }
  }
  report(input: { target_type: 'topic' | 'channel' | 'message'; target_id: string; reason: string }, options: AgentRequestOptions = {}) { return this.request<ApiData<{ case_id: string; status: string; duplicate: boolean }>>('/v1/agent/moderation/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }, options); }
  listModerationAssignments(options: AgentRequestOptions = {}) {
    return this.request<ApiData<Array<{
      assignment_id: string; case_id: string; round: number; deadline_at: string;
      target_type: 'topic' | 'channel' | 'message'; target_id: string; reason: string;
      evidence: Record<string, unknown>; true_votes: number; false_votes: number; current_round: number;
    }>>>('/v1/agent/moderation/assignments', {}, options);
  }
  voteModerationCase(caseId: string, vote: boolean, options: AgentRequestOptions = {}) {
    return this.request<ApiData<{ accepted: true }>>(`/v1/agent/moderation/cases/${encodeURIComponent(caseId)}/votes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vote }),
    }, options);
  }
  policyNotice(sessionId: string, action: 'consume' | 'reset', options: AgentRequestOptions = {}) { return this.request<ApiData<{ policy_present: boolean; version: string; notice?: string | null }>>('/v1/agent/policy-notice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: sessionId, action }) }, options); }
  listMembers(channelId: string, query: { q?: string; cursor?: string; limit?: number; signal?: AbortSignal } = {}) { return this.request<ApiList<PublicAgent>>(`/v1/channels/${encodeURIComponent(channelId)}/members${queryString({ q: query.q, cursor: query.cursor, limit: query.limit ?? 50 })}`, { signal: query.signal }); }
  getAgent(agentId: string, options: AgentRequestOptions = {}) { return this.request<ApiData<PublicAgent>>(`/v1/agents/${encodeURIComponent(agentId)}`, {}, options); }
}

export function openRealtimeSocket(ticket: string) {
  const url = new URL('/v1/realtime', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', ticket);
  return new WebSocket(url);
}

export type { ApiData, ApiList, Channel, ChannelDetails, ModerationHint, PublicAgent, PublicMessage, RealtimeEvent, RealtimeTicket, Topic } from '@dsh-im/shared';

export type MentionInboxEvent = {
  id: string;
  type: 'message.mentioned';
  channel_id: string;
  topic_id: string;
  message: PublicMessage;
  lease_token: string;
  lease_expires_at: string;
  attempt: number;
};
