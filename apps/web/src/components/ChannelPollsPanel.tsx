import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { listChannelPolls, type ChannelPoll } from '../api';
import { createRequestGeneration } from './request-generation';

type Props = { channelId: string; refreshKey?: number; hiddenPollId?: string | null };
type LoadState = 'loading' | 'ready' | 'error';
type PollRow = { kind: 'summary' } | { kind: 'poll'; poll: ChannelPoll } | { kind: 'day'; key: string; label: string; count: number; expanded: boolean };

function localDay(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dayLabel(day: string) {
  const today = localDay(new Date().toISOString());
  const date = new Date(`${day}T12:00:00`);
  return day === today ? '今天' : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
}

function remaining(endsAt: string) {
  const ms = Math.max(0, new Date(endsAt).getTime() - Date.now());
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24) return `剩余 ${Math.floor(hours / 24)} 天`;
  if (hours > 0) return `剩余 ${hours} 小时`;
  return `剩余 ${Math.max(1, Math.floor(ms / 60_000))} 分钟`;
}

export function ChannelPollsPanel({ channelId, refreshKey = 0, hiddenPollId = null }: Props) {
  const [active, setActive] = useState<ChannelPoll[]>([]);
  const [closed, setClosed] = useState<ChannelPoll[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadingRef = useRef(false);
  const refreshKeyRef = useRef(refreshKey);
  const [requestGeneration] = useState(createRequestGeneration);

  const loadFirstPage = useCallback(async (signal?: AbortSignal) => {
    const generation = requestGeneration.begin();
    loadingRef.current = false;
    setLoadingMore(false);
    setState(current => current === 'ready' ? current : 'loading');
    setError('');
    try {
      const [openResult, closedResult] = await Promise.all([
        listChannelPolls(channelId, { status: 'open', limit: 20, signal }),
        listChannelPolls(channelId, { status: 'closed', limit: 20, signal }),
      ]);
      if (signal?.aborted || !requestGeneration.isCurrent(generation)) return;
      setActive(openResult.data);
      setClosed(closedResult.data);
      setCursor(closedResult.page.next_cursor ?? null);
      setHasMore(closedResult.page.has_more);
      setState('ready');
    } catch (caught) {
      if (signal?.aborted || !requestGeneration.isCurrent(generation)) return;
      setError(caught instanceof Error ? caught.message : '暂时无法读取投票');
      setState('error');
    }
  }, [channelId]);

  useEffect(() => {
    const controller = new AbortController();
    setActive([]);
    setClosed([]);
    setExpandedDays(new Set());
    setHasMore(false);
    setCursor(null);
    void loadFirstPage(controller.signal);
    return () => {
      controller.abort();
      requestGeneration.begin();
    };
  }, [loadFirstPage]);

  useEffect(() => {
    if (refreshKeyRef.current === refreshKey) return;
    refreshKeyRef.current = refreshKey;
    void loadFirstPage();
  }, [loadFirstPage, refreshKey]);

  useEffect(() => {
    if (!hiddenPollId) return;
    setActive(current => current.filter(poll => poll.id !== hiddenPollId));
    setClosed(current => current.filter(poll => poll.id !== hiddenPollId));
  }, [hiddenPollId]);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || !hasMore || !cursor) return;
    const generation = requestGeneration.current();
    loadingRef.current = true;
    setLoadingMore(true);
    try {
      const result = await listChannelPolls(channelId, { status: 'closed', limit: 20, cursor });
      if (!requestGeneration.isCurrent(generation)) return;
      setClosed(current => {
        const existing = new Set(current.map(poll => poll.id));
        return [...current, ...result.data.filter(poll => !existing.has(poll.id))];
      });
      setCursor(result.page.next_cursor ?? null);
      setHasMore(result.page.has_more);
    } catch (caught) {
      if (requestGeneration.isCurrent(generation)) setError(caught instanceof Error ? caught.message : '历史投票加载失败');
    } finally {
      loadingRef.current = false;
      if (requestGeneration.isCurrent(generation)) setLoadingMore(false);
    }
  }, [channelId, cursor, hasMore]);

  const visibleActive = useMemo(() => active.filter(poll => poll.id !== hiddenPollId), [active, hiddenPollId]);
  const visibleClosed = useMemo(() => closed.filter(poll => poll.id !== hiddenPollId), [closed, hiddenPollId]);

  const rows = useMemo<PollRow[]>(() => {
    const result: PollRow[] = [{ kind: 'summary' }, ...visibleActive.map(poll => ({ kind: 'poll' as const, poll }))];
    const groups = new Map<string, ChannelPoll[]>();
    for (const poll of visibleClosed) {
      const day = localDay(poll.created_at);
      groups.set(day, [...(groups.get(day) ?? []), poll]);
    }
    for (const [day, polls] of groups) {
      const expanded = expandedDays.has(day);
      result.push({ kind: 'day', key: day, label: dayLabel(day), count: polls.length, expanded });
      if (expanded) result.push(...polls.map(poll => ({ kind: 'poll' as const, poll })));
    }
    return result;
  }, [visibleActive, visibleClosed, expandedDays]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: index => rows[index]?.kind === 'summary' ? 32 : rows[index]?.kind === 'day' ? 38 : 170,
    overscan: 5,
  });

  const virtualItems = virtualizer.getVirtualItems();

  if (state === 'loading' && !visibleActive.length && !visibleClosed.length) return <div className="polls-panel-state">正在加载投票…</div>;
  if (state === 'error' && !visibleActive.length && !visibleClosed.length) return <div className="polls-panel-state"><span>{error || '暂时无法读取投票'}</span><button type="button" onClick={() => void loadFirstPage()}>重试</button></div>;

  return <div className="polls-panel-content">
    <div className="polls-virtual-scroll" ref={scrollRef}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualItems.map(item => {
          const row = rows[item.index];
          if (!row) return null;
          return <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} className={`poll-virtual-row${row.kind === 'summary' ? ' poll-summary-row' : ''}`} style={{ transform: `translateY(${item.start}px)` }}>
            {row.kind === 'summary' ? <div className="polls-summary">{visibleActive.length} 个进行中{visibleClosed.length ? ` · ${visibleClosed.length} 个已结束` : ''}</div> : row.kind === 'day' ? <button className="poll-day-toggle" type="button" aria-expanded={row.expanded} onClick={() => setExpandedDays(current => {
              const next = new Set(current);
              if (next.has(row.key)) next.delete(row.key); else next.add(row.key);
              return next;
            })}><span className={`poll-day-chevron ${row.expanded ? 'is-expanded' : ''}`}>›</span><strong>{row.label}</strong><span>{row.count} 项</span></button> : <PollCard poll={row.poll} />}
          </div>;
        })}
      </div>
      {loadingMore && <div className="polls-panel-state">正在加载更早的投票…</div>}
      {hasMore && !loadingMore && <div className="polls-load-more"><button type="button" onClick={() => void loadMore()}>加载更早的投票</button></div>}
      {error && state === 'ready' && <div className="polls-panel-state"><span>{error}</span><button type="button" onClick={() => void loadMore()}>重试</button></div>}
      {state === 'ready' && visibleActive.length === 0 && visibleClosed.length === 0 && <div className="polls-panel-state">这个频道还没有投票</div>}
    </div>
  </div>;
}

function PollCard({ poll }: { poll: ChannelPoll }) {
  const closed = poll.status === 'closed';
  const resultByOption = new Map(poll.results?.options.map(item => [item.option_id, item]) ?? []);
  return <article className="channel-poll-card">
    <div className="channel-poll-card-head"><span className={`poll-status ${closed ? 'is-closed' : ''}`}>{closed ? (poll.closed_reason === 'admin' ? '管理员关闭' : '已结束') : '进行中'}</span><span>{closed ? new Date(poll.closed_at ?? poll.ends_at).toLocaleString() : remaining(poll.ends_at)}</span></div>
    <h3>{poll.title}</h3>
    <div className="poll-created-by">由 {poll.created_by.name} 发起 · {poll.duration}</div>
    <div className="poll-option-list">{poll.options.map(option => {
      const result = resultByOption.get(option.id);
      const winner = poll.results?.winner_option_ids.includes(option.id) ?? false;
      return <div className={`poll-option${winner ? ' is-winner' : ''}`} key={option.id}>
        <div className="poll-option-label"><span>{option.text}</span>{closed && result && <strong>{result.votes} · {result.percentage}%</strong>}</div>
        {closed && result && <div className="poll-option-track"><i style={{ width: `${result.percentage}%` }} /></div>}
      </div>;
    })}</div>
    {closed && poll.results && <div className="poll-final-count">{poll.results.total_votes} 票{poll.results.total_votes === 0 ? ' · 无人投票' : poll.results.winner_option_ids.length > 1 ? ' · 并列' : ''}</div>}
  </article>;
}
