const pollRefreshEvents = new Set([
  'channel.poll.created',
  'channel.poll.changed',
  'channel.poll.closed',
  'channel.poll.hidden',
  'channel.poll.restored',
]);

export function pollRealtimeUpdate(type: string, data: unknown, channelId: string) {
  if (!pollRefreshEvents.has(type) || !data || typeof data !== 'object' || !('channel_id' in data)
    || String(data.channel_id) !== channelId) return null;
  if (type === 'channel.poll.hidden' && 'poll_id' in data) {
    return { refresh: true, hiddenPollId: String(data.poll_id) };
  }
  if (type === 'channel.poll.restored' && 'poll_id' in data) {
    return { refresh: true, restoredPollId: String(data.poll_id) };
  }
  return { refresh: true };
}

export function shouldMarkPollsUnread(type: string, activeTab: 'members' | 'polls', sidebarVisible: boolean) {
  return type === 'channel.poll.created' && (activeTab !== 'polls' || !sidebarVisible);
}

export function shouldClearPollsUnread(activeTab: 'members' | 'polls', sidebarVisible: boolean) {
  return activeTab === 'polls' && sidebarVisible;
}

export type HiddenPollMasks = Map<string, Set<string>>;

export function addHiddenPollMask(current: HiddenPollMasks, channelId: string, pollId: string): HiddenPollMasks {
  const next = new Map(current);
  const channelPolls = new Set(current.get(channelId) ?? []);
  channelPolls.add(pollId);
  next.set(channelId, channelPolls);
  return next;
}

export function removeHiddenPollMask(current: HiddenPollMasks, channelId: string, pollId: string): HiddenPollMasks {
  const existing = current.get(channelId);
  if (!existing?.has(pollId)) return current;
  const next = new Map(current);
  const channelPolls = new Set(existing);
  channelPolls.delete(pollId);
  if (channelPolls.size) next.set(channelId, channelPolls);
  else next.delete(channelId);
  return next;
}

export function reconcileHiddenPollsAfterSync(current: HiddenPollMasks, syncedChannelId: string): HiddenPollMasks {
  if (!current.has(syncedChannelId)) return current;
  const next = new Map(current);
  next.delete(syncedChannelId);
  return next;
}
