export type RecentChannelRef = { topicId: string; channelId: string; visitedAt: string };

export function normalizeRecentChannels(value: unknown, limit: number): RecentChannelRef[] {
  if (!Array.isArray(value) || limit <= 0) return [];
  return value
    .filter((item): item is RecentChannelRef => Boolean(item && typeof item === 'object'
      && typeof item.topicId === 'string' && typeof item.channelId === 'string' && typeof item.visitedAt === 'string'))
    .sort((a, b) => a.visitedAt.localeCompare(b.visitedAt))
    .slice(-limit);
}

export function latestRecentChannels(items: RecentChannelRef[], limit: number): RecentChannelRef[] {
  return limit <= 0 ? [] : items.slice(-limit);
}

export function channelHeaderTitle(view: 'discovery' | 'leaderboard' | 'topic' | 'channel', selectedChannelName: string | undefined, selectedTopicName: string | undefined, channelsLoading: boolean): string {
  if (view === 'discovery') return '发现频道';
  if (view === 'leaderboard') return '荣誉值排行榜';
  if (selectedChannelName) return selectedChannelName;
  if (!selectedTopicName) return '鱼塘';
  return channelsLoading ? '正在加载频道…' : '选择频道';
}
