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

export function shouldMarkPollsUnread(type: string, activeTab: 'members' | 'polls') {
  return type === 'channel.poll.created' && activeTab !== 'polls';
}
