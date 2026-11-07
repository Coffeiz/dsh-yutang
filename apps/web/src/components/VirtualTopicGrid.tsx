import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Topic } from '../../../../packages/client/src/index.js';

const ROW_HEIGHT = 154;
const MOBILE_BREAKPOINT = 768;
const DESKTOP_COLUMNS = 2;

type Props = {
  topics: Topic[];
  scrollRef: RefObject<HTMLDivElement | null>;
  hasMore: boolean;
  loadingMore: boolean;
  loadError: string;
  onLoadMore: (manual?: boolean) => void;
  onChooseTopic: (topic: Topic) => void;
};

export function VirtualTopicGrid({ topics, scrollRef, hasMore, loadingMore, loadError, onLoadMore, onChooseTopic }: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState(() => ({
    columns: typeof window !== 'undefined' && window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches ? 1 : DESKTOP_COLUMNS,
    scrollMargin: 0,
  }));
  const rowCount = Math.ceil(topics.length / layout.columns);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 3,
    scrollMargin: layout.scrollMargin,
  });
  const virtualRows = virtualizer.getVirtualItems();

  useLayoutEffect(() => {
    const grid = gridRef.current;
    const scroll = scrollRef.current;
    if (!grid || !scroll) return;
    const mobileLayout = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);
    const update = () => {
      const columns = mobileLayout.matches ? 1 : DESKTOP_COLUMNS;
      const gridRect = grid.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      const scrollMargin = gridRect.top - scrollRect.top + scroll.scrollTop;
      setLayout(current => current.columns === columns && current.scrollMargin === scrollMargin ? current : { columns, scrollMargin });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(grid);
    observer.observe(scroll);
    mobileLayout.addEventListener('change', update);
    return () => {
      observer.disconnect();
      mobileLayout.removeEventListener('change', update);
    };
  }, [scrollRef]);

  useEffect(() => {
    const lastRow = virtualRows.at(-1);
    if (hasMore && !loadingMore && !loadError && lastRow && lastRow.index >= rowCount - 3) onLoadMore();
  }, [hasMore, loadError, loadingMore, onLoadMore, rowCount, virtualRows]);

  return <>
    <div
      ref={gridRef}
      className="topic-card-grid"
      style={{ height: `${virtualizer.getTotalSize()}px` }}
      aria-busy={loadingMore}
    >
      {virtualRows.map(row => <div
        className="topic-virtual-row"
        key={row.key}
        style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`, transform: `translateY(${row.start - layout.scrollMargin}px)` }}
      >
        {topics.slice(row.index * layout.columns, (row.index + 1) * layout.columns).map(topic => <button
          className={`topic-card${topics.length === 1 ? ' topic-card-single' : ''}`}
          key={topic.id}
          onClick={() => onChooseTopic(topic)}
        >
          <span className="topic-card-avatar">{topic.name.trim().charAt(0).toLocaleUpperCase() || '鱼'}</span>
          <span className="topic-card-title">{topic.name}{topic.moderation_hints.length > 0 && <span className="content-risk-badge" title="Server 词库或规则提示；不代表违规判定">敏感内容提示</span>}</span>
          <span className="topic-card-metrics"><span><strong>{topic.channel_count}</strong>频道</span><span><strong>{topic.agent_count}</strong>Agent</span></span>
          <i className="ri-arrow-right-line topic-card-arrow" aria-hidden="true" />
        </button>)}
      </div>)}
    </div>
    {loadingMore && <div className="discovery-pagination-state"><span className="loading-spinner" />正在加载更多话题…</div>}
    {hasMore && loadError && <div className="discovery-pagination-state discovery-state-error"><span>{loadError}</span><button className="secondary-button" onClick={() => onLoadMore(true)}>点击重试</button></div>}
  </>;
}
