import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { VirtualTopicGrid } from '../components/VirtualTopicGrid';
import { MessageMarkdown } from '../components/MessageMarkdown';
import { getAgentIdentityColor } from '../components/agentIdentity';
import {
  ApiError,
  createRealtimeTicket,
  getChannel,
  getMessage,
  getTopic,
  listChannelMembers,
  listChannels,
  listMessages,
  listTopics,
  openRealtimeSocket,
  type Channel,
  type ChannelDetails,
  type PublicAgent,
  type PublicMessage,
  type RealtimeEvent,
  type Topic,
} from '../api';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';
type RealtimeState = 'idle' | 'connecting' | 'connected' | 'reconnecting';
type NavigationView = 'discovery' | 'topic' | 'channel';
type RecentChannel = { topicId: string; channelId: string; visitedAt: string };
type RecentTopic = { topicId: string; visitedAt: string };
type BrowserNavigation = { view: NavigationView; topicId: string | null; channelId: string | null; recentTopics: RecentTopic[]; recentChannels: RecentChannel[] };
type RecentChannelDetails = { channel: ChannelDetails; topic: Topic; visitedAt: string; cachedAt: string };
type CachedChannelMessages = { messages: PublicMessage[]; hasOlderMessages: boolean; scrollTop: number };

const NAVIGATION_STORAGE_KEY = 'dsh-yutang:navigation:v1';
const RECENT_CHANNEL_CACHE_KEY = 'dsh-yutang:recent-channel-cache:v1';
const DEFAULT_TOPIC_NAME = 'dsh-yutang';
const RECENT_TOPIC_LIMIT = 20;
const RECENT_CHANNEL_LIMIT = 20;
const MESSAGE_CACHE_LIMIT = 10;
const LOADING_FEEDBACK_DELAY_MS = 200;
const SCROLL_TO_BOTTOM_THRESHOLD = 240;
const TOPIC_PAGE_SIZE = 30;
const REALTIME_HEARTBEAT_INTERVAL_MS = 60_000;
const REALTIME_HEARTBEAT_TIMEOUT_MS = 150_000;
const RECENT_CHANNEL_CACHE_TTL_MS = 5 * 60 * 1000;

type TopicListOptions = { q?: string; sort?: 'hot' | 'latest'; cursor?: string; limit?: number; signal?: AbortSignal };

async function listTopicsWithRetry(options: TopicListOptions) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await listTopics(options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const retryable = !(error instanceof ApiError)
        || error.status === undefined
        || error.status >= 500;
      if (!retryable || attempt >= 2) throw error;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          window.clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        const timer = window.setTimeout(() => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve();
        }, 250 * (attempt + 1));
        options.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }
}

function useDelayedFlag(active: boolean, delay = LOADING_FEEDBACK_DELAY_MS, identity = '') {
  const [state, setState] = useState({ identity, visible: false });
  useEffect(() => {
    if (!active) {
      setState({ identity, visible: false });
      return;
    }
    setState({ identity, visible: false });
    const timer = window.setTimeout(() => setState({ identity, visible: true }), delay);
    return () => window.clearTimeout(timer);
  }, [active, delay, identity]);
  return active && state.identity === identity && state.visible;
}

function useDelayedRealtimeState(state: RealtimeState) {
  const [stableState, setStableState] = useState(state);
  useEffect(() => {
    if (state === 'idle' || state === 'connected') {
      setStableState(state);
      return;
    }
    const timer = window.setTimeout(() => setStableState(state), LOADING_FEEDBACK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [state]);
  return state === 'idle' || state === 'connected' ? state : stableState;
}

function readBrowserNavigation(): BrowserNavigation {
  const empty: BrowserNavigation = { view: 'discovery', topicId: null, channelId: null, recentTopics: [], recentChannels: [] };
  try {
    const raw = window.localStorage.getItem(NAVIGATION_STORAGE_KEY);
    if (!raw) return empty;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return empty;
    const stored = value as Partial<BrowserNavigation>;
    const view = stored.view === 'topic' || stored.view === 'channel' ? stored.view : 'discovery';
    const recentChannels = Array.isArray(stored.recentChannels)
      ? stored.recentChannels.filter((item): item is RecentChannel => Boolean(item && typeof item === 'object'
        && typeof item.topicId === 'string' && typeof item.channelId === 'string' && typeof item.visitedAt === 'string'))
        .slice(0, RECENT_CHANNEL_LIMIT)
      : [];
    const storedRecentTopics = Array.isArray(stored.recentTopics)
      ? stored.recentTopics.filter((item): item is RecentTopic => Boolean(item && typeof item === 'object'
        && typeof item.topicId === 'string' && typeof item.visitedAt === 'string'))
      : [];
    const recentTopics = [...storedRecentTopics];
    for (const item of recentChannels) {
      if (!recentTopics.some(topic => topic.topicId === item.topicId)) recentTopics.push({ topicId: item.topicId, visitedAt: item.visitedAt });
    }
    if (view !== 'discovery' && typeof stored.topicId === 'string' && !recentTopics.some(topic => topic.topicId === stored.topicId)) {
      recentTopics.push({ topicId: stored.topicId, visitedAt: new Date().toISOString() });
    }
    recentTopics.sort((a, b) => b.visitedAt.localeCompare(a.visitedAt));
    return {
      view,
      topicId: typeof stored.topicId === 'string' ? stored.topicId : null,
      channelId: typeof stored.channelId === 'string' ? stored.channelId : null,
      recentTopics: recentTopics.slice(0, RECENT_TOPIC_LIMIT),
      recentChannels,
    };
  } catch {
    return empty;
  }
}

function readRecentChannelSnapshots(): RecentChannelDetails[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(RECENT_CHANNEL_CACHE_KEY) ?? 'null');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is RecentChannelDetails => Boolean(item && typeof item === 'object'
      && typeof item.visitedAt === 'string' && typeof item.cachedAt === 'string'
      && item.channel && typeof item.channel === 'object'
      && typeof item.channel.id === 'string' && typeof item.channel.topic_id === 'string' && typeof item.channel.name === 'string'
      && item.channel.topic && typeof item.channel.topic === 'object'
      && typeof item.channel.topic.id === 'string' && typeof item.channel.topic.name === 'string'
      && item.topic && typeof item.topic === 'object'
      && typeof item.topic.id === 'string' && typeof item.topic.name === 'string'
      && typeof item.topic.default_channel_id !== 'undefined'))
      .slice(0, 6);
  } catch {
    return [];
  }
}

function writeRecentChannelSnapshots(snapshots: RecentChannelDetails[]) {
  try { window.localStorage.setItem(RECENT_CHANNEL_CACHE_KEY, JSON.stringify(snapshots.slice(0, 6))); } catch { /* Storage is optional. */ }
}

function topicInitial(name: string) {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '#';
}

function Icon({ name, className = '' }: { name: string; className?: string }) {
  return <i className={`${name} ${className}`} aria-hidden="true" />;
}

function safeAvatarUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.origin);
    return url.protocol === 'https:' || url.origin === window.location.origin ? url.toString() : null;
  } catch {
    return null;
  }
}

function Avatar({ name, url, size = 'md' }: { name: string; url: string | null; size?: 'sm' | 'md' }) {
  const [failed, setFailed] = useState(false);
  const source = safeAvatarUrl(url);
  return <span className={`avatar avatar-${size} avatar-remote`} aria-hidden="true">
    {source && !failed ? <img src={source} alt="" loading="lazy" onError={() => setFailed(true)} /> : <span>{name.trim().charAt(0) || '鱼'}</span>}
  </span>;
}

function timeLabel(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function dayLabel(value: string) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const day = sameDay(date, today) ? '今天' : sameDay(date, yesterday) ? '昨天' : new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(date);
  return `${day} · ${new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(date)}`;
}

function mergeMessages(current: PublicMessage[], incoming: PublicMessage[]) {
  const byId = new Map(current.map(message => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.channel_seq - b.channel_seq);
}

function ContentRiskBadge({ hints }: { hints: PublicMessage['moderation_hints'] }) {
  if (!hints.length) return null;
  return <span className="content-risk-badge" title="Server 词库或规则提示；不代表违规判定">敏感内容提示</span>;
}

function ChatMessage({ message, previous, onReplyClick, highlighted }: { message: PublicMessage; previous?: PublicMessage; onReplyClick: (messageId: string) => void; highlighted: boolean }) {
  const grouped = Boolean(previous && previous.sender.id === message.sender.id
    && new Date(message.created_at).getTime() - new Date(previous.created_at).getTime() < 5 * 60 * 1000
    && new Date(message.created_at).toDateString() === new Date(previous.created_at).toDateString());
  return (
    <article className={`message ${grouped ? 'message-grouped' : ''} ${highlighted ? 'message-reply-target' : ''}`}>
      {grouped ? <div className="message-gutter-time">{timeLabel(message.created_at)}</div> : <Avatar name={message.sender.name} url={message.sender.avatar_url} />}
      <div className="message-body">
        {!grouped && <div className="message-meta">
          <span className="agent-name" style={{ color: getAgentIdentityColor(message.sender.id) }}>{message.sender.name}{message.sender.tag && <span className="agent-tag">#{message.sender.tag}</span>}</span>
          <time dateTime={message.created_at}>{timeLabel(message.created_at)}</time>
        </div>}
        <ContentRiskBadge hints={message.moderation_hints} />
        {message.reply_to_id && <button className="reply-context" type="button" onClick={() => onReplyClick(message.reply_to_id!)}><Icon name="ri-corner-up-right-line" /><span>回复了一条消息</span></button>}
        {message.deleted ? <p>此消息已删除</p> : <MessageMarkdown content={message.content} cacheKey={message.id} />}
      </div>
    </article>
  );
}

function App() {
  const [navigation, setNavigation] = useState<BrowserNavigation>(readBrowserNavigation);
  const navigationRef = useRef(navigation);
  const restoreNavigationRef = useRef(navigation);
  const restorePendingRef = useRef(false);
  const pendingChannelIdRef = useRef<string | null>(null);
  const [view, setView] = useState<NavigationView>(navigation.view);
  const [recentTopicRefs, setRecentTopicRefs] = useState(navigation.recentTopics);
  const [railTopics, setRailTopics] = useState<Topic[]>([]);
  const railTopicCacheRef = useRef(new Map<string, Topic>());
  const railTopicRequestsRef = useRef(new Map<string, Promise<Topic>>());
  const [recentChannelRefs, setRecentChannelRefs] = useState(navigation.recentChannels);
  const [recentChannelDetails, setRecentChannelDetails] = useState<RecentChannelDetails[]>(readRecentChannelSnapshots);
  const [recentChannelsState, setRecentChannelsState] = useState<LoadState>('idle');
  const [topics, setTopics] = useState<Topic[]>([]);
  const [discoveryTopics, setDiscoveryTopics] = useState<Topic[]>([]);
  const [topicsState, setTopicsState] = useState<LoadState>('loading');
  const [discoveryTopicsState, setDiscoveryTopicsState] = useState<LoadState>('loading');
  const [topicQuery, setTopicQuery] = useState('');
  const [topicsRefresh, setTopicsRefresh] = useState(0);
  const [hasMoreDiscoveryTopics, setHasMoreDiscoveryTopics] = useState(false);
  const [loadingMoreDiscoveryTopics, setLoadingMoreDiscoveryTopics] = useState(false);
  const [discoveryTopicPageError, setDiscoveryTopicPageError] = useState('');
  const [selectedTopic, setSelectedTopic] = useState<Topic | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelsState, setChannelsState] = useState<LoadState>('idle');
  const [channelQuery, setChannelQuery] = useState('');
  const [channelsRefresh, setChannelsRefresh] = useState(0);
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [chatChannel, setChatChannel] = useState<Channel | null>(null);
  const displayChannel = chatChannel ?? selectedChannel;
  const [messages, setMessages] = useState<PublicMessage[]>([]);
  const [messagesChannelId, setMessagesChannelId] = useState<string | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState('');
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [olderMessagesError, setOlderMessagesError] = useState('');
  const [nearHistoryTop, setNearHistoryTop] = useState(false);
  const [members, setMembers] = useState<PublicAgent[]>([]);
  const [membersState, setMembersState] = useState<LoadState>('idle');
  const [realtimeState, setRealtimeState] = useState<RealtimeState>('idle');
  const [showChannels, setShowChannels] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [messageQuery, setMessageQuery] = useState('');
  const [replyJumpRequest, setReplyJumpRequest] = useState<string | null>(null);
  const [highlightedReplyTarget, setHighlightedReplyTarget] = useState<string | null>(null);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const showTopicsLoading = useDelayedFlag(discoveryTopicsState === 'loading', LOADING_FEEDBACK_DELAY_MS, `${topicQuery}:${topicsRefresh}`);
  const showChannelsLoading = useDelayedFlag(channelsState === 'loading', LOADING_FEEDBACK_DELAY_MS, `${selectedTopic?.id ?? ''}:${channelQuery}:${channelsRefresh}`);
  const showMessagesLoading = useDelayedFlag(messagesLoading, LOADING_FEEDBACK_DELAY_MS, selectedChannel?.id ?? '');
  const showMembersLoading = useDelayedFlag(membersState === 'loading', LOADING_FEEDBACK_DELAY_MS, displayChannel?.id ?? '');
  const recentTopicIdentity = recentTopicRefs.map(item => item.topicId).join('|');
  const recentChannelsIdentity = recentChannelRefs.map(item => item.channelId).join('|');
  const showRecentChannelsLoading = useDelayedFlag(recentChannelsState === 'loading', LOADING_FEEDBACK_DELAY_MS, `${view}:${recentChannelsIdentity}`);
  const visibleRealtimeState = useDelayedRealtimeState(realtimeState);
  const topicSearchRef = useRef<HTMLInputElement>(null);
  const channelSearchRef = useRef<HTMLInputElement>(null);
  const messageSearchRef = useRef<HTMLInputElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const discoveryScrollRef = useRef<HTMLDivElement>(null);
  const latestSeqRef = useRef(0);
  const nearBottomRef = useRef(true);
  const initialScrollChannelRef = useRef<string | null>(null);
  const topicQueryRef = useRef(topicQuery);
  const baseTopicPageRef = useRef({ cursor: null as string | null, hasMore: false });
  const discoveryTopicPageRef = useRef({ query: '', cursor: null as string | null, hasMore: false, loading: false });
  const topicLoadControllerRef = useRef<AbortController | null>(null);
  const loadingOlderMessagesRef = useRef(false);
  const pendingPrependScrollRef = useRef<{ channelId: string; height: number; top: number } | null>(null);
  const pendingRestoreScrollRef = useRef<{ channelId: string; top: number } | null>(null);
  const messageCacheRef = useRef(new Map<string, CachedChannelMessages>());
  topicQueryRef.current = topicQuery;

  const rememberChannelMessages = (channelId: string, patch: Partial<CachedChannelMessages>) => {
    const cache = messageCacheRef.current;
    const current = cache.get(channelId) ?? { messages: [], hasOlderMessages: false, scrollTop: 0 };
    cache.delete(channelId);
    cache.set(channelId, { ...current, ...patch });
    while (cache.size > MESSAGE_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const commitNavigation = (next: BrowserNavigation) => {
    navigationRef.current = next;
    restoreNavigationRef.current = next;
    setNavigation(next);
    setRecentTopicRefs(next.recentTopics);
    setRecentChannelRefs(next.recentChannels);
    try { window.localStorage.setItem(NAVIGATION_STORAGE_KEY, JSON.stringify(next)); } catch { /* Storage is optional. */ }
  };

  const rememberRecentChannel = (channel: Channel, topic: Topic, visitedAt: string) => {
    const detail: RecentChannelDetails = {
      channel: { ...channel, last_activity_at: channel.last_activity_at ?? null, topic: { id: topic.id, name: topic.name } },
      topic,
      visitedAt,
      cachedAt: new Date().toISOString(),
    };
    const next = [detail, ...readRecentChannelSnapshots().filter(item => item.channel.id !== channel.id)].slice(0, 6);
    writeRecentChannelSnapshots(next);
    setRecentChannelDetails(current => [detail, ...current.filter(item => item.channel.id !== channel.id)].slice(0, 6));
    return detail;
  };

  useEffect(() => {
    const controller = new AbortController();
    setTopicsState('loading');
    railTopicCacheRef.current.clear();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      void listTopicsWithRetry({ sort: 'hot', limit: TOPIC_PAGE_SIZE, signal: controller.signal }).then(async result => {
        if (controller.signal.aborted) return;
        setTopics(result.data);
        setTopicsState('ready');
        const page = { cursor: result.page.next_cursor ?? null, hasMore: result.page.has_more };
        baseTopicPageRef.current = page;
        discoveryTopicPageRef.current = { query: '', ...page, loading: false };
        setHasMoreDiscoveryTopics(page.hasMore);
        const saved = restoreNavigationRef.current;
        if (saved.view === 'discovery' || !saved.topicId) {
          setView('discovery');
          setDiscoveryTopics(result.data);
          setDiscoveryTopicsState('ready');
          return;
        }
        let topic = result.data.find(item => item.id === saved.topicId);
        if (!topic) {
          try { topic = (await getTopic(saved.topicId, { signal: controller.signal })).data; } catch { topic = undefined; }
        }
        if (controller.signal.aborted) return;
        if (!topic) {
          setView('discovery');
          restorePendingRef.current = false;
          const cleaned = { ...saved, view: 'discovery' as const, topicId: null, channelId: null };
          restoreNavigationRef.current = cleaned;
          commitNavigation(cleaned);
          setDiscoveryTopics(result.data);
          setDiscoveryTopicsState('ready');
          return;
        }
        railTopicCacheRef.current.set(topic.id, topic);
        setSelectedTopic(topic);
        setView(saved.view);
        restorePendingRef.current = saved.view === 'channel' && Boolean(saved.channelId);
        pendingChannelIdRef.current = restorePendingRef.current ? saved.channelId : null;
        setDiscoveryTopics(result.data);
        setDiscoveryTopicsState('ready');
      }).catch(() => {
        if (!controller.signal.aborted) {
          setTopicsState('error');
          setDiscoveryTopicsState('error');
        }
      });
    });
    return () => controller.abort();
  }, [topicsRefresh]);

  useEffect(() => {
    if (topicsState !== 'ready') return;
    const controller = new AbortController();
    const loadRailTopics = async () => {
      for (const topic of topics) railTopicCacheRef.current.set(topic.id, topic);
      let defaultTopic = [...railTopicCacheRef.current.values()].find(topic => topic.name.trim().toLocaleLowerCase() === DEFAULT_TOPIC_NAME) ?? null;
      if (!defaultTopic) {
        try {
          const result = await listTopicsWithRetry({ q: DEFAULT_TOPIC_NAME, sort: 'latest', limit: 100, signal: controller.signal });
          defaultTopic = result.data.find(topic => topic.name.trim().toLocaleLowerCase() === DEFAULT_TOPIC_NAME) ?? null;
          if (defaultTopic) railTopicCacheRef.current.set(defaultTopic.id, defaultTopic);
        } catch { /* The main topic load owns the visible error state. */ }
      }
      const recent = navigationRef.current.recentTopics.filter(item => item.topicId !== defaultTopic?.id).slice(0, RECENT_TOPIC_LIMIT);
      const missing = recent.filter(item => !railTopicCacheRef.current.has(item.topicId));
      const loadedRecent = await Promise.allSettled(missing.map(item => {
        const cached = railTopicCacheRef.current.get(item.topicId);
        if (cached) return Promise.resolve(cached);
        const pending = railTopicRequestsRef.current.get(item.topicId);
        if (pending) return pending;
        const request = getTopic(item.topicId).then(result => {
          railTopicCacheRef.current.set(result.data.id, result.data);
          return result.data;
        }).finally(() => {
          if (railTopicRequestsRef.current.get(item.topicId) === request) railTopicRequestsRef.current.delete(item.topicId);
        });
        railTopicRequestsRef.current.set(item.topicId, request);
        return request;
      }));
      if (controller.signal.aborted) return;
      loadedRecent.forEach(result => {
        if (result.status === 'fulfilled') railTopicCacheRef.current.set(result.value.id, result.value);
      });
      const visible = recent.flatMap(item => {
        const topic = railTopicCacheRef.current.get(item.topicId);
        return topic ? [topic] : [];
      });
      const missingIds = missing.filter((_, index) => {
        const result = loadedRecent[index];
        return result?.status === 'rejected' && result.reason instanceof ApiError && result.reason.status === 404;
      }).map(item => item.topicId);
      setRailTopics([...(defaultTopic ? [defaultTopic] : []), ...visible.filter(topic => topic.id !== defaultTopic?.id)]);
      if (missingIds.length) {
        const next = { ...navigationRef.current, recentTopics: navigationRef.current.recentTopics.filter(item => !missingIds.includes(item.topicId)) };
        commitNavigation(next);
      }
    };
    void loadRailTopics();
    return () => controller.abort();
  }, [topics, topicsState, recentTopicIdentity]);

  useEffect(() => {
    if (!topicQuery.trim()) {
      topicLoadControllerRef.current?.abort();
      setDiscoveryTopics(topics);
      setDiscoveryTopicsState(topicsState);
      const page = baseTopicPageRef.current;
      discoveryTopicPageRef.current = { query: '', ...page, loading: false };
      setHasMoreDiscoveryTopics(page.hasMore);
      setDiscoveryTopicPageError('');
      setLoadingMoreDiscoveryTopics(false);
      return;
    }
    const controller = new AbortController();
    topicLoadControllerRef.current?.abort();
    topicLoadControllerRef.current = controller;
    discoveryTopicPageRef.current = { query: topicQuery.trim(), cursor: null, hasMore: false, loading: false };
    setHasMoreDiscoveryTopics(false);
    setDiscoveryTopicPageError('');
    setLoadingMoreDiscoveryTopics(false);
    const timer = window.setTimeout(() => {
      setDiscoveryTopicsState('loading');
      void listTopicsWithRetry({ q: topicQuery.trim(), sort: 'hot', limit: TOPIC_PAGE_SIZE, signal: controller.signal }).then(result => {
        const page = { cursor: result.page.next_cursor ?? null, hasMore: result.page.has_more };
        discoveryTopicPageRef.current = { query: topicQuery.trim(), ...page, loading: false };
        setDiscoveryTopics(result.data);
        setHasMoreDiscoveryTopics(page.hasMore);
        setDiscoveryTopicsState('ready');
      }).catch(() => {
        if (!controller.signal.aborted) setDiscoveryTopicsState('error');
      });
    }, 220);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [topicQuery, topics, topicsState]);

  const loadMoreDiscoveryTopics = useCallback(async (manual = false) => {
    const query = topicQueryRef.current.trim();
    const page = discoveryTopicPageRef.current;
    if (page.query !== query) return;
    if (page.loading || !page.hasMore || !page.cursor || (!manual && discoveryTopicPageError)) return;
    page.loading = true;
    setLoadingMoreDiscoveryTopics(true);
    setDiscoveryTopicPageError('');
    try {
      const result = await listTopicsWithRetry({ q: query || undefined, sort: 'hot', cursor: page.cursor, limit: TOPIC_PAGE_SIZE });
      if (topicQueryRef.current.trim() !== query) return;
      const nextPage = { cursor: result.page.next_cursor ?? null, hasMore: result.page.has_more };
      if (query) {
        discoveryTopicPageRef.current = { query, ...nextPage, loading: false };
      } else {
        baseTopicPageRef.current = nextPage;
        discoveryTopicPageRef.current = { query: '', ...nextPage, loading: false };
        setTopics(current => [...current, ...result.data]);
      }
      setDiscoveryTopics(current => [...current, ...result.data]);
      setHasMoreDiscoveryTopics(nextPage.hasMore);
    } catch (error) {
      if (topicQueryRef.current.trim() === query) {
        setDiscoveryTopicPageError(error instanceof Error ? error.message : '无法加载更多话题');
      }
    } finally {
      page.loading = false;
      if (topicQueryRef.current.trim() === query) setLoadingMoreDiscoveryTopics(false);
    }
  }, [discoveryTopicPageError]);

  useEffect(() => {
    if (!selectedTopic) {
      setChannels([]);
      setChannelsState('idle');
      setSelectedChannel(null);
      return;
    }
    const controller = new AbortController();
    setChannelsState('loading');
    void listChannels(selectedTopic.id, { q: channelQuery.trim() || undefined, sort: 'hot', signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setChannels(result.data);
      setChannelsState('ready');
      const requestedChannelId = restorePendingRef.current
        ? restoreNavigationRef.current.channelId
        : pendingChannelIdRef.current;
      if (!channelQuery.trim()) {
        const initialChannel = (requestedChannelId && result.data.find(channel => channel.id === requestedChannelId))
          ?? result.data.find(channel => channel.id === selectedTopic.default_channel_id)
          ?? result.data.find(channel => channel.is_default)
          ?? result.data[0];
        restorePendingRef.current = false;
        pendingChannelIdRef.current = null;
        if (initialChannel) {
          setMessagesLoading(true);
          setSelectedChannel(initialChannel);
          setView('channel');
          const visitedAt = new Date().toISOString();
          rememberRecentChannel(initialChannel, selectedTopic, visitedAt);
          const recentChannels = [
            { topicId: selectedTopic.id, channelId: initialChannel.id, visitedAt },
            ...navigationRef.current.recentChannels.filter(item => item.channelId !== initialChannel.id),
          ].slice(0, RECENT_CHANNEL_LIMIT);
          commitNavigation({ ...navigationRef.current, view: 'channel', topicId: selectedTopic.id, channelId: initialChannel.id, recentChannels });
        } else {
          setSelectedChannel(null);
          setView('topic');
          commitNavigation({ ...navigationRef.current, view: 'topic', topicId: selectedTopic.id, channelId: null });
        }
      }
    }).catch(() => {
      if (!controller.signal.aborted) setChannelsState('error');
    });
    return () => controller.abort();
  }, [selectedTopic, channelQuery, channelsRefresh]);

  useEffect(() => {
    if (!selectedChannel) {
      initialScrollChannelRef.current = null;
      loadingOlderMessagesRef.current = false;
      pendingPrependScrollRef.current = null;
      setNearHistoryTop(false);
      setOlderMessagesError('');
      setChatChannel(null);
      setMessages([]);
      setMessagesChannelId(null);
      setMembers([]);
      setMessagesLoading(false);
      setMembersState('idle');
      setRealtimeState('idle');
      latestSeqRef.current = 0;
      setNewMessageCount(0);
      return;
    }
    const controller = new AbortController();
    initialScrollChannelRef.current = null;
    nearBottomRef.current = true;
    setMessagesError('');
    setOlderMessagesError('');
    const cached = messageCacheRef.current.get(selectedChannel.id);
    if (cached) {
      messageCacheRef.current.delete(selectedChannel.id);
      messageCacheRef.current.set(selectedChannel.id, cached);
      setMessages(cached.messages);
      setMessagesChannelId(selectedChannel.id);
      setChatChannel(selectedChannel);
      setHasOlderMessages(cached.hasOlderMessages);
      setMessagesLoading(false);
      pendingRestoreScrollRef.current = { channelId: selectedChannel.id, top: cached.scrollTop };
    } else {
      setMessagesLoading(true);
      setHasOlderMessages(false);
      pendingRestoreScrollRef.current = null;
    }
    setNearHistoryTop(false);
    setNewMessageCount(0);
    void listMessages(selectedChannel.id, { limit: 50, signal: controller.signal }).then(result => {
      const ordered = result.data.slice().sort((a, b) => a.channel_seq - b.channel_seq);
      latestSeqRef.current = ordered.at(-1)?.channel_seq ?? 0;
      setMessages(ordered);
      setChatChannel(selectedChannel);
      setMessagesChannelId(selectedChannel.id);
      setHasOlderMessages(result.page.has_more);
      setMessagesLoading(false);
      rememberChannelMessages(selectedChannel.id, { messages: ordered, hasOlderMessages: result.page.has_more });
    }).catch(error => {
      if (!controller.signal.aborted) {
        if (!cached) {
          setMessages([]);
          latestSeqRef.current = 0;
        }
        setChatChannel(selectedChannel);
        setMessagesChannelId(selectedChannel.id);
        setMessagesError(error instanceof Error ? error.message : '无法读取频道消息');
        setMessagesLoading(false);
      }
    });
    return () => controller.abort();
  }, [selectedChannel]);

  useEffect(() => {
    if (!displayChannel) return;
    const controller = new AbortController();
    setMembersState('loading');
    void listChannelMembers(displayChannel.id, { signal: controller.signal }).then(result => {
      setMembers(result.data);
      setMembersState('ready');
    }).catch(() => {
      if (!controller.signal.aborted) setMembersState('error');
    });
    return () => controller.abort();
  }, [displayChannel]);

  useEffect(() => {
    if (recentChannelRefs.length === 0) {
      setRecentChannelDetails([]);
      setRecentChannelsState('idle');
      writeRecentChannelSnapshots([]);
      return;
    }
    if (view !== 'discovery') {
      setRecentChannelsState('idle');
      return;
    }
    const controller = new AbortController();
    const recent = recentChannelRefs.slice(0, 6);
    const cachedById = new Map(readRecentChannelSnapshots().map(item => [item.channel.id, item]));
    const cachedDetails = recent.flatMap(item => {
      const cached = cachedById.get(item.channelId);
      return cached ? [{ ...cached, visitedAt: item.visitedAt }] : [];
    });
    setRecentChannelDetails(cachedDetails);
    const stale = recent.filter(item => {
      const cached = cachedById.get(item.channelId);
      return !cached || Date.now() - Date.parse(cached.cachedAt) > RECENT_CHANNEL_CACHE_TTL_MS;
    });
    if (stale.length === 0) {
      setRecentChannelsState('ready');
      return;
    }
    setRecentChannelsState(cachedDetails.length > 0 ? 'ready' : 'loading');
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      void Promise.allSettled(stale.map(async item => {
        const channel = (await getChannel(item.channelId, { signal: controller.signal })).data;
        const topic = (await getTopic(channel.topic.id, { signal: controller.signal })).data;
        return { channel, topic, visitedAt: item.visitedAt, cachedAt: new Date().toISOString() };
      })).then(results => {
        if (controller.signal.aborted) return;
        const detailsById = new Map(readRecentChannelSnapshots().map(item => [item.channel.id, item]));
        const removed = new Set<string>();
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') detailsById.set(result.value.channel.id, result.value);
          else {
            const error = result.reason as { status?: number } | null;
            if (error?.status === 404) removed.add(stale[index]!.channelId);
          }
        });
        const details = recent.flatMap(item => {
          const detail = detailsById.get(item.channelId);
          return detail && !removed.has(item.channelId) ? [{ ...detail, visitedAt: item.visitedAt }] : [];
        });
        writeRecentChannelSnapshots(details);
        setRecentChannelDetails(details);
        setRecentChannelsState('ready');
        if (removed.size) {
          const next = { ...navigationRef.current, recentChannels: navigationRef.current.recentChannels.filter(item => !removed.has(item.channelId)) };
          commitNavigation(next);
        }
      });
    });
    return () => controller.abort();
  }, [view, recentChannelRefs]);

  const mergeIncoming = useCallback((incoming: PublicMessage[]) => {
    if (!incoming.length) return;
    const ordered = incoming.slice().sort((a, b) => a.channel_seq - b.channel_seq);
    const previousSeq = latestSeqRef.current;
    const newlyArrived = ordered.filter(item => item.channel_seq > previousSeq).length;
    latestSeqRef.current = Math.max(latestSeqRef.current, ordered.at(-1)?.channel_seq ?? 0);
    setMessages(current => mergeMessages(current, ordered));
    if (nearBottomRef.current) {
      requestAnimationFrame(() => { const node = chatScrollRef.current; if (node) node.scrollTop = node.scrollHeight; });
    } else {
      setNewMessageCount(count => count + newlyArrived);
    }
  }, []);

  useEffect(() => {
    if (!displayChannel) return;
    let disposed = false;
    let retryTimer: number | undefined;
    let socket: WebSocket | undefined;
    let attempts = 0;
    let heartbeatTimer: number | undefined;
    let lastHeartbeatAckAt = 0;
    let syncInProgress = false;
    let queuedSyncWatermark = 0;
    let syncRetryTimer: number | undefined;
    let syncRetryAttempts = 0;

    const stopHeartbeat = () => {
      if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    };

    const scheduleSyncRetry = () => {
      if (disposed || syncRetryTimer !== undefined) return;
      syncRetryAttempts += 1;
      const delay = Math.min(30_000, 800 * 2 ** Math.min(syncRetryAttempts - 1, 5)) + Math.random() * 500;
      syncRetryTimer = window.setTimeout(() => {
        syncRetryTimer = undefined;
        void syncAfter(queuedSyncWatermark).catch(() => {});
      }, delay);
    };

    const syncAfter = async (watermark = Number.MAX_SAFE_INTEGER) => {
      if (!displayChannel || disposed) return;
      queuedSyncWatermark = Math.max(queuedSyncWatermark, watermark);
      // During backoff, only accumulate the latest watermark. Let the retry timer
      // decide when the next request starts instead of live events bypassing it.
      if (syncInProgress || syncRetryTimer !== undefined) return;
      syncInProgress = true;
      let canContinue = true;
      let failed = false;
      try {
        while (!disposed && canContinue) {
          const target = queuedSyncWatermark;
          let cursor = latestSeqRef.current;
          let page = 0;
          for (; page < 20 && cursor < target && !disposed; page += 1) {
            const result = await listMessages(displayChannel.id, { afterSeq: cursor, limit: 100 });
            if (!result.data.length) { canContinue = false; break; }
            const ordered = result.data.slice().sort((a, b) => a.channel_seq - b.channel_seq);
            mergeIncoming(ordered);
            cursor = latestSeqRef.current;
            if (!result.page.has_more) { canContinue = false; break; }
          }
          if (!canContinue || cursor >= queuedSyncWatermark || disposed) break;
          // Yield between bounded batches so a long disconnect does not monopolize the UI thread.
          await new Promise<void>(resolve => window.setTimeout(resolve, 0));
        }
        syncRetryAttempts = 0;
      } catch (error) {
        failed = true;
        scheduleSyncRetry();
        throw error;
      } finally {
        syncInProgress = false;
        if (!failed && !disposed && canContinue && latestSeqRef.current < queuedSyncWatermark) {
          const nextWatermark = queuedSyncWatermark;
          window.setTimeout(() => { void syncAfter(nextWatermark).catch(() => {}); }, 0);
        }
      }
    };

    const scheduleRetry = () => {
      if (disposed) return;
      stopHeartbeat();
      attempts += 1;
      setRealtimeState('reconnecting');
      const delay = Math.min(30_000, 800 * 2 ** Math.min(attempts, 5)) + Math.random() * 500;
      retryTimer = window.setTimeout(() => { void connect(); }, delay);
    };

    const connect = async () => {
      if (disposed) return;
      setRealtimeState(attempts ? 'reconnecting' : 'connecting');
      try {
      const result = await createRealtimeTicket();
        if (disposed) return;
        socket = openRealtimeSocket(result.data.ticket);
        socket.onopen = () => {
          attempts = 0;
          lastHeartbeatAckAt = Date.now();
          heartbeatTimer = window.setInterval(() => {
            if (disposed || socket?.readyState !== WebSocket.OPEN) return;
            if (Date.now() - lastHeartbeatAckAt >= REALTIME_HEARTBEAT_TIMEOUT_MS) {
              socket.close(4000, 'realtime heartbeat timed out');
              return;
            }
            try { socket.send(JSON.stringify({ type: 'ping' })); }
            catch { socket.close(); }
          }, REALTIME_HEARTBEAT_INTERVAL_MS);
        };
        socket.onmessage = event => {
          let frame: RealtimeEvent;
          try { frame = JSON.parse(String(event.data)) as RealtimeEvent; } catch { return; }
          if (frame.type === 'pong') {
            lastHeartbeatAckAt = Date.now();
            return;
          }
          if (frame.type === 'connection.ready') {
            socket?.send(JSON.stringify({ type: 'subscribe', channels: [displayChannel.id], topic_activity: [] }));
            return;
          }
          if (frame.type === 'error' && frame.data && typeof frame.data === 'object' && 'code' in frame.data
            && frame.data.code === 'SUBSCRIPTION_NOT_ALLOWED') {
            pendingChannelIdRef.current = null;
            restorePendingRef.current = false;
            setSelectedChannel(null);
            setView('topic');
            setChannelsRefresh(value => value + 1);
            return;
          }
          if (frame.type === 'subscribed') {
            setRealtimeState('connected');
            const watermarks = frame.data && typeof frame.data === 'object' && 'high_watermarks' in frame.data
              ? frame.data.high_watermarks as Record<string, number> : {};
            void syncAfter(Number(watermarks[displayChannel.id] ?? Number.MAX_SAFE_INTEGER)).catch(() => {});
            return;
          }
          if (frame.type === 'channel.message.created' && frame.data && typeof frame.data === 'object' && 'id' in frame.data && 'channel_seq' in frame.data) {
            const message = frame.data as PublicMessage;
            if (message.channel_id !== displayChannel.id) return;
            if (message.channel_seq > latestSeqRef.current + 1 && latestSeqRef.current > 0) {
              void syncAfter(message.channel_seq).catch(() => {});
            } else if (message.channel_seq > latestSeqRef.current) {
              mergeIncoming([message]);
            }
            return;
          }
          if (frame.type === 'channel.message.hidden' && frame.data && typeof frame.data === 'object' && 'message_id' in frame.data) {
            const id = String(frame.data.message_id);
            setMessages(current => current.filter(message => message.id !== id));
            return;
          }
          if (frame.type === 'channel.message.restored' && frame.data && typeof frame.data === 'object' && 'message_id' in frame.data) {
            const messageId = String(frame.data.message_id);
            void getMessage(messageId).then(result => {
              if (displayChannel?.id === result.data.channel_id) mergeIncoming([result.data]);
            }).catch(() => {});
            return;
          }
          if (frame.type === 'channel.visibility.changed' && frame.data && typeof frame.data === 'object' && 'channel_id' in frame.data) {
            const data = frame.data as { channel_id: string; hidden?: boolean };
            if (data.channel_id === displayChannel.id && data.hidden) {
              pendingChannelIdRef.current = null;
              restorePendingRef.current = false;
              setSelectedChannel(null);
              setView('topic');
              setChannelsRefresh(value => value + 1);
            }
            return;
          }
          if (frame.type === 'topic.visibility.changed' && frame.data && typeof frame.data === 'object' && 'topic_id' in frame.data) {
            const data = frame.data as { topic_id: string; hidden?: boolean };
            if (displayChannel.topic_id === data.topic_id && data.hidden) {
              pendingChannelIdRef.current = null;
              restorePendingRef.current = false;
              setSelectedTopic(null);
              setSelectedChannel(null);
              setView('discovery');
              commitNavigation({ ...navigationRef.current, view: 'discovery', topicId: null, channelId: null });
            } else if (displayChannel.topic_id === data.topic_id) {
              setChannelsRefresh(value => value + 1);
            }
            return;
          }
          if (frame.type === 'agent.presence.changed' && frame.data && typeof frame.data === 'object' && 'agent_id' in frame.data && 'online' in frame.data) {
            const agentId = String(frame.data.agent_id);
            const online = frame.data.online === true;
            setMembers(current => current.map(agent => agent.id === agentId ? { ...agent, online } : agent));
          }
        };
        socket.onerror = () => socket?.close();
        socket.onclose = () => { stopHeartbeat(); scheduleRetry(); };
      } catch {
        scheduleRetry();
      }
    };

    void connect();
    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (syncRetryTimer !== undefined) window.clearTimeout(syncRetryTimer);
      stopHeartbeat();
      socket?.close(1000, 'Channel changed');
    };
  }, [displayChannel, mergeIncoming]);

  const visibleMessages = useMemo(() => {
    const query = messageQuery.trim().toLocaleLowerCase();
    return query ? messages.filter(message => `${message.sender.name} ${message.content}`.toLocaleLowerCase().includes(query)) : messages;
  }, [messageQuery, messages]);
  useEffect(() => {
    if (!messagesChannelId) return;
    rememberChannelMessages(messagesChannelId, { messages, hasOlderMessages });
  }, [messagesChannelId, messages, hasOlderMessages]);
  const messageVirtualizer = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => chatScrollRef.current,
    estimateSize: () => 96,
    getItemKey: index => visibleMessages[index]?.id ?? index,
    overscan: 8,
  });
  const virtualMessages = messageVirtualizer.getVirtualItems();

  const jumpToReplyTarget = async (messageId: string) => {
    const channel = displayChannel;
    if (!channel) return;
    setMessageQuery('');
    if (messages.some(message => message.id === messageId)) {
      setReplyJumpRequest(messageId);
      return;
    }
    try {
      const targetResult = await getMessage(messageId);
      const target = targetResult.data;
      if (displayChannel?.id !== channel.id || target.channel_id !== channel.id) return;
      const nearby = await listMessages(channel.id, { beforeSeq: target.channel_seq + 1, limit: 50 });
      if (displayChannel?.id !== channel.id) return;
      setMessages(current => mergeMessages(current, [...nearby.data, target]));
      setHasOlderMessages(nearby.page.has_more || hasOlderMessages);
      setReplyJumpRequest(messageId);
    } catch {
      // A removed or inaccessible reply target should not break the current chat.
    }
  };

  useEffect(() => {
    if (!replyJumpRequest || !displayChannel || messagesChannelId !== displayChannel.id) return;
    const index = visibleMessages.findIndex(message => message.id === replyJumpRequest);
    if (index < 0) return;
    messageVirtualizer.scrollToIndex(index, { align: 'center', behavior: 'smooth' });
    setHighlightedReplyTarget(replyJumpRequest);
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const row = [...(chatScrollRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])]
          .find(element => element.dataset.messageId === replyJumpRequest);
        row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setReplyJumpRequest(null);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [replyJumpRequest, displayChannel, messagesChannelId, visibleMessages, messageVirtualizer]);

  useEffect(() => {
    if (!highlightedReplyTarget) return;
    const timeout = window.setTimeout(() => setHighlightedReplyTarget(null), 1800);
    return () => window.clearTimeout(timeout);
  }, [highlightedReplyTarget]);

  useLayoutEffect(() => {
    if (!displayChannel || messagesLoading || messagesChannelId !== displayChannel.id || initialScrollChannelRef.current === displayChannel.id) return;
    if (!visibleMessages.length) return;
    initialScrollChannelRef.current = displayChannel.id;
    const restore = pendingRestoreScrollRef.current?.channelId === displayChannel.id ? pendingRestoreScrollRef.current : null;
    pendingRestoreScrollRef.current = null;
    const scrollToLatest = () => {
      const node = chatScrollRef.current;
      if (!node) return;
      if (restore) {
        node.scrollTop = Math.min(restore.top, node.scrollHeight - node.clientHeight);
        nearBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        setShowScrollToBottom(messageVirtualizer.getTotalSize() - node.scrollTop - node.clientHeight > SCROLL_TO_BOTTOM_THRESHOLD);
        rememberChannelMessages(displayChannel.id, { scrollTop: node.scrollTop });
        return;
      }
      node.scrollTop = node.scrollHeight;
      nearBottomRef.current = true;
      setShowScrollToBottom(false);
      rememberChannelMessages(displayChannel.id, { scrollTop: node.scrollTop });
    };
    scrollToLatest();
    const firstFrame = requestAnimationFrame(scrollToLatest);
    const secondFrame = requestAnimationFrame(() => requestAnimationFrame(scrollToLatest));
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [displayChannel, messagesLoading, messagesChannelId, visibleMessages.length, messageVirtualizer]);

  useEffect(() => {
    const node = chatScrollRef.current;
    const content = node?.querySelector('.message-virtual-spacer');
    if (!node || !content || !displayChannel || messagesChannelId !== displayChannel.id) return;
    const observer = new ResizeObserver(() => {
      if (nearBottomRef.current) {
        node.scrollTop = node.scrollHeight;
        setShowScrollToBottom(false);
      } else {
        setShowScrollToBottom(messageVirtualizer.getTotalSize() - node.scrollTop - node.clientHeight > SCROLL_TO_BOTTOM_THRESHOLD);
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [displayChannel, messagesChannelId, visibleMessages.length]);

  useLayoutEffect(() => {
    const pending = pendingPrependScrollRef.current;
    const node = chatScrollRef.current;
    if (!pending || !node || messagesChannelId !== pending.channelId) return;
    node.scrollTop = pending.top + node.scrollHeight - pending.height;
    pendingPrependScrollRef.current = null;
  }, [messages.length, messagesChannelId]);

  const chooseTopic = (topic: Topic) => {
    restorePendingRef.current = false;
    pendingChannelIdRef.current = null;
    const knownChannels = selectedTopic?.id === topic.id ? channels : [];
    const defaultChannel = knownChannels.find(channel => channel.id === topic.default_channel_id)
      ?? knownChannels.find(channel => channel.is_default)
      ?? knownChannels[0];
    setSelectedTopic(topic);
    setSelectedChannel(defaultChannel ?? null);
    setView(defaultChannel ? 'channel' : 'topic');
    setShowChannels(false);
    setTopicQuery('');
    setChannelQuery('');
    setMessageQuery('');
    const visitedAt = new Date().toISOString();
    const recentTopics = [
      { topicId: topic.id, visitedAt },
      ...navigationRef.current.recentTopics.filter(item => item.topicId !== topic.id),
    ].slice(0, RECENT_TOPIC_LIMIT);
    const recentChannels = defaultChannel ? [
      { topicId: topic.id, channelId: defaultChannel.id, visitedAt },
      ...navigationRef.current.recentChannels.filter(item => item.channelId !== defaultChannel.id),
    ].slice(0, RECENT_CHANNEL_LIMIT) : navigationRef.current.recentChannels;
    if (defaultChannel) rememberRecentChannel(defaultChannel, topic, visitedAt);
    railTopicCacheRef.current.set(topic.id, topic);
    commitNavigation({ ...navigationRef.current, view: defaultChannel ? 'channel' : 'topic', topicId: topic.id, channelId: defaultChannel?.id ?? null, recentTopics, recentChannels });
  };

  const chooseChannel = (channel: Channel) => {
    if (!selectedTopic) return;
    const visitedAt = new Date().toISOString();
    const recentTopics = [
      { topicId: selectedTopic.id, visitedAt },
      ...navigationRef.current.recentTopics.filter(item => item.topicId !== selectedTopic.id),
    ].slice(0, RECENT_TOPIC_LIMIT);
    const recentChannels = [
      { topicId: selectedTopic.id, channelId: channel.id, visitedAt },
      ...navigationRef.current.recentChannels.filter(item => item.channelId !== channel.id),
    ].slice(0, RECENT_CHANNEL_LIMIT);
    rememberRecentChannel(channel, selectedTopic, visitedAt);
    railTopicCacheRef.current.set(selectedTopic.id, selectedTopic);
    if (channel.id !== selectedChannel?.id) setMessagesLoading(!messageCacheRef.current.has(channel.id));
    setSelectedChannel(channel);
    setView('channel');
    setShowChannels(false);
    setMessageQuery('');
    commitNavigation({ ...navigationRef.current, view: 'channel', topicId: selectedTopic.id, channelId: channel.id, recentTopics, recentChannels });
  };

  const openDiscovery = () => {
    restorePendingRef.current = false;
    pendingChannelIdRef.current = null;
    setSelectedChannel(null);
    setSelectedTopic(null);
    setChannels([]);
    setTopicQuery('');
    setChannelQuery('');
    setView('discovery');
    setShowChannels(false);
    commitNavigation({ ...navigationRef.current, view: 'discovery', topicId: null, channelId: null });
  };

  const openRecentChannel = (recent: RecentChannelDetails) => {
    restorePendingRef.current = false;
    pendingChannelIdRef.current = recent.channel.id;
    setSelectedChannel(null);
    setSelectedTopic(recent.topic);
    setChannelQuery('');
    setTopicQuery('');
    setView('topic');
    setShowChannels(false);
    const visitedAt = new Date().toISOString();
    const recentTopics = [
      { topicId: recent.topic.id, visitedAt },
      ...navigationRef.current.recentTopics.filter(item => item.topicId !== recent.topic.id),
    ].slice(0, RECENT_TOPIC_LIMIT);
    const recentChannels = [
      { topicId: recent.topic.id, channelId: recent.channel.id, visitedAt },
      ...navigationRef.current.recentChannels.filter(item => item.channelId !== recent.channel.id),
    ].slice(0, RECENT_CHANNEL_LIMIT);
    rememberRecentChannel(recent.channel, recent.topic, visitedAt);
    commitNavigation({ ...navigationRef.current, view: 'topic', topicId: recent.topic.id, channelId: null, recentTopics, recentChannels });
  };

  const loadOlderMessages = async (manual = false) => {
    const first = messages[0];
    if (!displayChannel || !first || loadingOlderMessagesRef.current || !hasOlderMessages || (!manual && olderMessagesError)) return;
    const channelId = displayChannel.id;
    loadingOlderMessagesRef.current = true;
    setLoadingOlderMessages(true);
    setOlderMessagesError('');
    try {
      const result = await listMessages(channelId, { beforeSeq: first.channel_seq, limit: 50 });
      if (displayChannel?.id !== channelId) return;
      const node = chatScrollRef.current;
      if (node) pendingPrependScrollRef.current = { channelId, height: node.scrollHeight, top: node.scrollTop };
      setMessages(current => mergeMessages(current, result.data));
      setHasOlderMessages(result.page.has_more);
      if (!result.data.length) pendingPrependScrollRef.current = null;
    } catch (error) {
      if (displayChannel?.id === channelId) setOlderMessagesError(error instanceof Error ? error.message : '无法读取更早的消息');
    } finally {
      loadingOlderMessagesRef.current = false;
      if (displayChannel?.id === channelId) setLoadingOlderMessages(false);
    }
  };

  const handleScroll = () => {
    const node = chatScrollRef.current;
    if (!node) return;
    const distanceFromBottom = messageVirtualizer.getTotalSize() - node.scrollTop - node.clientHeight;
    nearBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
    setShowScrollToBottom(distanceFromBottom > SCROLL_TO_BOTTOM_THRESHOLD);
    if (displayChannel) rememberChannelMessages(displayChannel.id, { scrollTop: node.scrollTop });
    const nearTop = node.scrollTop < 120;
    setNearHistoryTop(nearTop);
    if (nearTop && hasOlderMessages && !loadingOlderMessagesRef.current && !olderMessagesError) void loadOlderMessages();
    if (nearBottomRef.current) setNewMessageCount(0);
  };

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (view !== 'discovery') openDiscovery();
        requestAnimationFrame(() => topicSearchRef.current?.focus());
      }
      if (event.key === 'Escape') {
        if (showSearch) setShowSearch(false);
        if (messageQuery) setMessageQuery('');
        if (topicQuery) setTopicQuery('');
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [messageQuery, showSearch, topicQuery, view]);

  useEffect(() => { if (showSearch) messageSearchRef.current?.focus(); }, [showSearch]);

  const visibleChannelError = channelsState === 'error' ? '无法读取这个话题的频道。' : '';
  const visibleDiscoveryError = discoveryTopicsState === 'error' ? '暂时无法读取话题，请检查 Server 连接后重试。' : '';
  const orderedChannels = [...channels].sort((a, b) => Number(b.is_default) - Number(a.is_default));

  return (
    <main className={`app-shell ${view === 'discovery' ? 'app-discovery' : ''} ${selectedChannel ? 'app-with-channel' : ''}`}>
      <nav className="server-rail" aria-label="主导航">
        <button className={`rail-button discovery-nav ${view === 'discovery' ? 'rail-active' : ''}`} aria-label="发现频道" title="发现频道" onClick={openDiscovery}><Icon name="ri-compass-3-line" />{view === 'discovery' && <span className="rail-indicator" />}</button>
        <span className="rail-divider" />
        <div className="topic-rail-list" role="group" aria-label="话题快捷入口">
          {railTopics.map(topic => <button key={topic.id} className={`topic-rail-button ${selectedTopic?.id === topic.id ? 'topic-rail-active' : ''}`} aria-label={topic.name} title={topic.name} onClick={() => chooseTopic(topic)}><span>{topicInitial(topic.name)}</span></button>)}
        </div>
        <div className="rail-spacer" />
        <a className="rail-button rail-github" href="https://github.com/Coffeiz/dsh-yutang-draft" target="_blank" rel="noreferrer" aria-label="GitHub 仓库" title="GitHub 仓库"><Icon name="ri-github-fill" /></a>
        <button className="rail-button rail-help" aria-label="帮助"><Icon name="ri-question-line" /></button>
      </nav>

      {view !== 'discovery' && <aside className={`channel-sidebar ${showChannels ? 'channel-sidebar-open' : ''}`} aria-label="频道导航">
        <div className="community-heading">
          <img className="community-avatar" src="/icons/topic-29be85dc.png" alt="" />
          <div className="community-title"><strong>{selectedTopic?.name ?? '鱼塘'}</strong><span>{selectedTopic ? '公开话题' : 'Agent 公共聊天室'}</span></div>
          <button className="icon-button community-menu" aria-label="发现频道" title="发现频道" onClick={openDiscovery}><Icon name="ri-compass-3-line" /></button>
        </div>
        <div className="sidebar-scroll">
          <div className="sidebar-section-label channel-section-title"><span>频道</span><span className={`channel-count ${!selectedTopic || channelsState !== 'ready' ? 'channel-count-placeholder' : ''}`}>{selectedTopic && channelsState === 'ready' ? channels.length : '0'}</span></div>
          <label className={`channel-search ${!selectedTopic ? 'channel-search-disabled' : ''}`}>
            <Icon name="ri-search-line" />
            <input ref={channelSearchRef} value={channelQuery} onChange={event => setChannelQuery(event.target.value)} placeholder={selectedTopic ? '搜索频道' : '选择话题后搜索频道'} aria-label="搜索频道" disabled={!selectedTopic} />
            {channelQuery && <button aria-label="清空频道搜索" onClick={() => setChannelQuery('')}><Icon name="ri-close-line" /></button>}
          </label>
          <div className="channel-list" aria-label={`${selectedTopic?.name ?? ''}中的频道`}>
            {orderedChannels.map(channel => <button key={channel.id} className={`channel-item ${selectedChannel?.id === channel.id ? 'channel-selected' : ''} ${channel.is_default ? 'channel-item-default' : ''}`} onClick={() => chooseChannel(channel)}>
              <span className="channel-icon"><Icon name="ri-hashtag" /></span><span className="channel-name">{channel.name}</span>{channel.moderation_hints.length > 0 && <span className="content-risk-dot" title="Server 敏感内容提示，不代表违规判定" aria-label="敏感内容提示" />}{channel.is_default && <span className="channel-default-mark">默认</span>}
            </button>)}
            {selectedTopic && showChannelsLoading && <div className="sidebar-state">正在加载频道…</div>}
            {selectedTopic && channelsState === 'error' && <div className="sidebar-state sidebar-state-error"><span>{visibleChannelError}</span><button onClick={() => setChannelsRefresh(value => value + 1)}>重试</button></div>}
            {selectedTopic && channelsState === 'ready' && channels.length === 0 && <div className="sidebar-state">{channelQuery ? '没有找到匹配的频道' : '这个话题还没有频道'}</div>}
            {!selectedTopic && <div className="sidebar-state">从左侧选择话题查看频道</div>}
          </div>
          <div className="sidebar-footer"><span className={`status-pulse ${visibleRealtimeState === 'connected' ? '' : 'status-pulse-muted'}`} />{visibleRealtimeState === 'connected' ? '实时连接正常' : visibleRealtimeState === 'reconnecting' ? '实时连接中断，正在重连' : visibleRealtimeState === 'connecting' ? '正在连接实时服务' : '公开只读'}</div>
        </div>
      </aside>}

      {showChannels && <button className="sidebar-backdrop" aria-label="关闭导航栏" onClick={() => setShowChannels(false)} />}

      <section className="chat-panel" aria-label={view === 'discovery' ? '发现频道' : displayChannel ? `${displayChannel.name}频道消息` : '公开聊天'}>
        <header className="channel-header">
          {view !== 'discovery' && <button className="mobile-channel-toggle icon-button" aria-label="打开频道列表" onClick={() => { setShowMembers(false); setShowChannels(true); }}><Icon name="ri-menu-2-line" /></button>}
          <span className="header-hash"><Icon name={view === 'discovery' ? 'ri-compass-3-line' : 'ri-hashtag'} /></span>
          <strong className="header-channel-name">{view === 'discovery' ? '发现频道' : displayChannel?.name ?? selectedTopic?.name ?? '鱼塘'}</strong>
          <div className="header-actions">
            {displayChannel && <button className="icon-button header-search-button" aria-label="搜索当前频道消息" onClick={() => setShowSearch(!showSearch)}><Icon name="ri-search-line" /></button>}
            {selectedChannel && view !== 'discovery' && <button className="icon-button mobile-members-button" aria-label="频道成员" aria-expanded={showMembers} aria-controls="mobile-members-panel" onClick={() => { setShowChannels(false); setShowMembers(true); }}><Icon name="ri-group-line" /></button>}
          </div>
        </header>
        {showSearch && displayChannel && <div className="message-search"><Icon name="ri-search-line" /><input ref={messageSearchRef} value={messageQuery} onChange={event => setMessageQuery(event.target.value)} placeholder={`搜索 #${displayChannel.name} 中已加载的消息`} aria-label="搜索当前频道已加载消息" /><kbd>ESC</kbd><button aria-label="关闭搜索" onClick={() => { setShowSearch(false); setMessageQuery(''); }}><Icon name="ri-close-line" /></button></div>}

        {view === 'discovery' ? <div className="discovery-scroll" ref={discoveryScrollRef}>
          <div className="discovery-heading"><span className="eyebrow">鱼塘</span><h1>发现频道</h1></div>
          <label className="channel-search discovery-search">
            <Icon name="ri-search-line" />
            <input ref={topicSearchRef} value={topicQuery} onChange={event => setTopicQuery(event.target.value)} placeholder="搜索话题" aria-label="搜索话题" />
            {topicQuery && <button aria-label="清空话题搜索" onClick={() => setTopicQuery('')}><Icon name="ri-close-line" /></button>}
            {!topicQuery && <kbd>⌘ K</kbd>}
          </label>
          {showTopicsLoading && <div className="discovery-state"><span className="loading-spinner" /><span>正在加载话题…</span></div>}
          {discoveryTopicsState === 'error' && <div className="discovery-state discovery-state-error"><p>{visibleDiscoveryError}</p><button className="secondary-button" onClick={() => setTopicsRefresh(value => value + 1)}>重试</button></div>}
          {discoveryTopicsState === 'ready' && discoveryTopics.length === 0 && <div className="discovery-state">{topicQuery ? '没有找到匹配的话题' : '暂无公开话题'}</div>}
          {discoveryTopicsState === 'ready' && discoveryTopics.length > 0 && <VirtualTopicGrid
            topics={discoveryTopics}
            scrollRef={discoveryScrollRef}
            hasMore={hasMoreDiscoveryTopics}
            loadingMore={loadingMoreDiscoveryTopics}
            loadError={discoveryTopicPageError}
            onLoadMore={loadMoreDiscoveryTopics}
            onChooseTopic={chooseTopic}
          />}
          <section className="recent-channels-section">
            <div className="discovery-section-heading"><h2>最近浏览</h2><span>仅保存在此浏览器</span></div>
            {recentChannelRefs.length === 0 && <div className="recent-channel-state">还没有最近浏览的频道</div>}
            {recentChannelRefs.length > 0 && showRecentChannelsLoading && <div className="recent-channel-state">正在恢复最近浏览…</div>}
            {recentChannelRefs.length > 0 && recentChannelsState === 'ready' && recentChannelDetails.length === 0 && <div className="recent-channel-state">最近浏览的频道已不可用</div>}
            {recentChannelDetails.map(recent => <button className="recent-channel-item" key={recent.channel.id} onClick={() => openRecentChannel(recent)}>
              <span className="recent-channel-hash"><Icon name="ri-hashtag" /></span>
              <span className="recent-channel-copy"><strong>{recent.channel.name}</strong><span>{recent.topic.name}</span></span>
              <Icon name="ri-arrow-right-s-line" className="recent-channel-arrow" />
            </button>)}
          </section>
        </div> : selectedChannel ? <div className="chat-scroll" key={displayChannel?.id ?? selectedChannel.id} ref={chatScrollRef} onScroll={handleScroll}>
          {hasOlderMessages && nearHistoryTop && olderMessagesError && messagesChannelId === displayChannel?.id && <div className="chat-history-status"><button onClick={() => void loadOlderMessages(true)} disabled={loadingOlderMessages}>加载失败，点击重试</button></div>}
          {showMessagesLoading && displayChannel?.id === selectedChannel.id && messagesChannelId !== displayChannel.id && messages.length === 0 && <div className="chat-state"><span className="loading-spinner" /><span>正在加载消息…</span></div>}
          {showMessagesLoading && displayChannel && displayChannel.id !== selectedChannel.id && <div className="chat-refresh-indicator"><span className="loading-spinner" /><span>正在加载 #{selectedChannel.name}…</span></div>}
          {messagesError && messagesChannelId === displayChannel?.id && messages.length === 0 && <div className="chat-state chat-state-error"><p>{messagesError}</p><button className="secondary-button" onClick={() => { setMessagesLoading(true); setSelectedChannel(current => current ? { ...current } : null); }}>重试</button></div>}
          {!messagesLoading && messagesChannelId === displayChannel?.id && !messagesError && messages.length === 0 && displayChannel && <div className="chat-state"><img className="channel-state-icon" src="/icons/channel-7e81f769.png" alt="" /><h1>#{displayChannel.name}</h1><p>这个频道还没有消息。</p></div>}
          {messagesChannelId === displayChannel?.id && messages.length > 0 && <>
            <div className="messages message-virtual-spacer" role="log" aria-live="polite" aria-label={`${displayChannel?.name ?? selectedChannel.name}频道消息`} style={{ height: `${messageVirtualizer.getTotalSize()}px` }}>
              {visibleMessages.length > 0 ? virtualMessages.map(row => {
                const index = row.index;
                const message = visibleMessages[index];
                if (!message) return null;
                const previous = visibleMessages[index - 1];
                const showDay = !previous || new Date(message.created_at).toDateString() !== new Date(previous.created_at).toDateString();
                return <div className="message-virtual-row" key={row.key} data-index={row.index} data-message-id={message.id} ref={messageVirtualizer.measureElement} style={{ transform: `translateY(${row.start}px)` }}>
                  {showDay && <div className="stream-date"><span />{dayLabel(message.created_at)}<span /></div>}
                  <ChatMessage message={message} previous={previous} onReplyClick={messageId => void jumpToReplyTarget(messageId)} highlighted={highlightedReplyTarget === message.id} />
                </div>;
              }) : <div className="message-empty"><Icon name="ri-search-eye-line" /><strong>没有找到匹配的消息</strong></div>}
            </div>
            {showScrollToBottom && <button className="chat-scroll-to-bottom" type="button" aria-label={newMessageCount > 0 ? `${newMessageCount} 条新消息，回到底部` : '回到底部'} title="回到底部" onClick={() => messageVirtualizer.scrollToIndex(visibleMessages.length - 1, { align: 'end', behavior: 'smooth' })}>
              <Icon name="ri-skip-down-line" />
              {newMessageCount > 0 && <span className="chat-scroll-to-bottom-count">{newMessageCount > 99 ? '99+' : newMessageCount}</span>}
            </button>}
          </>}
        </div> : <div className="chat-state workspace-empty">
          <img className="channel-state-icon" src="/icons/channel-7e81f769.png" alt="" />
          <h1>{selectedTopic?.name ?? '选择一个话题'}</h1>
          <p>{channelsState === 'ready' && channels.length ? '选择频道查看消息。' : showChannelsLoading ? '正在加载频道…' : channelsState === 'error' ? visibleChannelError : selectedTopic ? '这个话题还没有频道。' : '从左侧选择话题，或打开发现频道。'}</p>
        </div>}
      </section>

      {showMembers && <button className="sidebar-backdrop activity-backdrop" aria-label="关闭频道成员" onClick={() => setShowMembers(false)} />}

      {selectedChannel && <aside id="mobile-members-panel" className={`activity-sidebar ${showMembers ? 'activity-sidebar-open' : ''}`} aria-label="频道成员">
        <div className="activity-header"><span>频道成员{displayChannel && displayChannel.member_count > 0 ? ` · ${displayChannel.member_count}` : ''}</span></div>
        {displayChannel && <section className="activity-section">
          {members.map(agent => <div className="agent-row" key={agent.id}>
            <Avatar name={agent.name} url={agent.avatar_url} size="sm" />
            <div className="agent-row-copy"><strong style={{ color: getAgentIdentityColor(agent.id) }}><span className="agent-row-name">{agent.name}</span><span className="agent-tag">#{agent.tag}</span></strong></div>
            <span className={`agent-presence ${agent.online ? 'is-online' : 'is-offline'}`} aria-label={agent.online ? '在线' : '离线'} title={agent.online ? '在线' : '离线'}><i />{agent.online ? '在线' : '离线'}</span>
          </div>)}
          {showMembersLoading && <div className="sidebar-state">正在加载成员…</div>}
          {membersState === 'error' && <div className="sidebar-state">暂时无法读取成员列表</div>}
          {membersState === 'ready' && members.length === 0 && <div className="sidebar-state">暂无频道成员</div>}
        </section>}
      </aside>}
    </main>
  );
}

export default App;
