import { ChannelPollsPanel } from '../../components/ChannelPollsPanel';
import { getAgentIdentityColor } from '../../components/agentIdentity';
import type { Channel, PublicAgent, Topic } from '../../api';
import { Avatar, Icon } from './Presentation';

export function ChannelSidebar({
  visible, open, topic, channels, selectedChannel, query, queryRef, loading, state, error, realtimeState,
  onDiscover, onQueryChange, onClearQuery, onChooseChannel, onRetry, onClose,
}: {
  visible: boolean; open: boolean; topic: Topic | null; channels: Channel[]; selectedChannel: Channel | null; query: string;
  queryRef: React.RefObject<HTMLInputElement | null>; loading: boolean; state: 'idle' | 'loading' | 'ready' | 'error';
  error: string; realtimeState: 'idle' | 'connecting' | 'connected' | 'reconnecting';
  onDiscover: () => void; onQueryChange: (value: string) => void; onClearQuery: () => void;
  onChooseChannel: (channel: Channel) => void; onRetry: () => void; onClose: () => void;
}) {
  const orderedChannels = [...channels].sort((a, b) => Number(b.is_default) - Number(a.is_default));
  const status = realtimeState === 'connected' ? '实时连接正常' : realtimeState === 'reconnecting' ? '实时连接中断，正在重连' : realtimeState === 'connecting' ? '正在连接实时服务' : '公开只读';
  return <>
    {visible && <aside className={`channel-sidebar ${open ? 'channel-sidebar-open' : ''}`} aria-label="频道导航">
      <div className="community-heading">
        <img className="community-avatar" src="/icons/topic-29be85dc.png" alt="" />
        <div className="community-title"><strong>{topic?.name ?? '鱼塘'}</strong><span>{topic ? '公开话题' : 'Agent 公共聊天室'}</span></div>
        <button className="icon-button community-menu" aria-label="发现频道" title="发现频道" onClick={onDiscover}><Icon name="ri-compass-3-line" /></button>
      </div>
      <div className="sidebar-scroll">
        <div className="sidebar-section-label channel-section-title"><span>频道</span><span className={`channel-count ${!topic || state !== 'ready' ? 'channel-count-placeholder' : ''}`}>{topic && state === 'ready' ? channels.length : '0'}</span></div>
          <label className={`channel-search ${!topic ? 'channel-search-disabled' : ''}`}>
          <Icon name="ri-search-line" />
          <input ref={queryRef} value={query} onChange={event => onQueryChange(event.target.value)} placeholder={topic ? '搜索频道' : '选择话题后搜索频道'} aria-label="搜索频道" disabled={!topic} />
          {query && <button aria-label="清空频道搜索" onClick={onClearQuery}><Icon name="ri-close-line" /></button>}
        </label>
        <div className="channel-list" aria-label={`${topic?.name ?? ''}中的频道`}>
          {orderedChannels.map(channel => <button key={channel.id} className={`channel-item ${selectedChannel?.id === channel.id ? 'channel-selected' : ''} ${channel.is_default ? 'channel-item-default' : ''}`} onClick={() => onChooseChannel(channel)}>
            <span className="channel-icon"><Icon name="ri-hashtag" /></span><span className="channel-name">{channel.name}</span>{channel.moderation_hints.length > 0 && <span className="content-risk-dot" title="Server 敏感内容提示，不代表违规判定" aria-label="敏感内容提示" />}{channel.is_default && <span className="channel-default-mark">默认</span>}
          </button>)}
          {topic && loading && <div className="sidebar-state">正在加载频道…</div>}
          {topic && state === 'error' && <div className="sidebar-state sidebar-state-error"><span>{error}</span><button onClick={onRetry}>重试</button></div>}
          {topic && state === 'ready' && channels.length === 0 && <div className="sidebar-state">{query ? '没有找到匹配的频道' : '这个话题还没有频道'}</div>}
          {!topic && <div className="sidebar-state">从左侧选择话题查看频道</div>}
        </div>
        <div className="sidebar-footer"><span className={`status-pulse ${realtimeState === 'connected' ? '' : 'status-pulse-muted'}`} />{status}</div>
      </div>
    </aside>}
    {open && <button className="sidebar-backdrop" aria-label="关闭导航栏" onClick={onClose} />}
  </>;
}

export function ActivitySidebar({ visible, channel, open, tab, members, membersState, membersLoading, pollsRefresh, hiddenPollId, onClose, onTabChange }: {
  visible: boolean; channel: Channel | null; open: boolean; tab: 'members' | 'polls'; members: PublicAgent[];
  membersState: 'idle' | 'loading' | 'ready' | 'error'; membersLoading: boolean; pollsRefresh: number; hiddenPollId: string | null;
  onClose: () => void; onTabChange: (tab: 'members' | 'polls') => void;
}) {
  if (!visible || !channel) return null;
  return <>
    {open && <button className="sidebar-backdrop activity-backdrop" aria-label="关闭频道成员" onClick={onClose} />}
    <aside id="mobile-members-panel" className={`activity-sidebar ${open ? 'activity-sidebar-open' : ''}`} aria-label="频道信息">
      <div className="activity-tabs" role="tablist" aria-label="频道侧栏">
        <button id="activity-members-tab" type="button" role="tab" aria-selected={tab === 'members'} aria-controls="activity-members-panel" className={tab === 'members' ? 'is-active' : ''} onClick={() => onTabChange('members')}>成员{channel.member_count > 0 ? ` · ${channel.member_count}` : ''}</button>
        <button id="activity-polls-tab" type="button" role="tab" aria-selected={tab === 'polls'} aria-controls="activity-polls-panel" className={tab === 'polls' ? 'is-active' : ''} onClick={() => onTabChange('polls')}>投票</button>
      </div>
      {tab === 'members' && <section id="activity-members-panel" className="activity-section" role="tabpanel" aria-labelledby="activity-members-tab">
        <div className="section-heading"><h3>频道成员</h3>{channel.member_count > 0 && <span className="activity-count">{channel.member_count}</span>}</div>
        {members.map(agent => <div className="agent-row" key={agent.id}>
          <Avatar name={agent.name} url={agent.avatar_url} size="sm" />
          <div className="agent-row-copy"><strong style={{ color: getAgentIdentityColor(agent.id) }}><span className="agent-row-name">{agent.name}</span><span className="agent-tag">#{agent.tag}</span></strong></div>
          <span className={`agent-presence ${agent.online ? 'is-online' : 'is-offline'}`} aria-label={agent.online ? '在线' : '离线'} title={agent.online ? '在线' : '离线'}><i />{agent.online ? '在线' : '离线'}</span>
        </div>)}
        {membersLoading && <div className="sidebar-state">正在加载成员…</div>}
        {membersState === 'error' && <div className="sidebar-state">暂时无法读取成员列表</div>}
        {membersState === 'ready' && members.length === 0 && <div className="sidebar-state">暂无频道成员</div>}
      </section>}
      {tab === 'polls' && <section id="activity-polls-panel" className="activity-polls-section" role="tabpanel" aria-labelledby="activity-polls-tab"><ChannelPollsPanel channelId={channel.id} refreshKey={pollsRefresh} hiddenPollId={hiddenPollId} /></section>}
    </aside>
  </>;
}
