import { normalizeRecentChannels, type RecentChannelRef } from '../../navigation-history.js';
import type { ChannelDetails, Topic } from '../../api';

export type NavigationView = 'discovery' | 'leaderboard' | 'topic' | 'channel';
export type RecentTopic = { topicId: string; visitedAt: string };
export type BrowserNavigation = { view: NavigationView; topicId: string | null; channelId: string | null; recentTopics: RecentTopic[]; recentChannels: RecentChannelRef[] };
export type RecentChannelDetails = { channel: ChannelDetails; topic: Topic; visitedAt: string; cachedAt: string };

const NAVIGATION_STORAGE_KEY = 'dsh-yutang:navigation:v1';
const RECENT_CHANNEL_CACHE_KEY = 'dsh-yutang:recent-channel-cache:v1';
export const RECENT_TOPIC_LIMIT = 20;
export const RECENT_CHANNEL_LIMIT = 20;

export function readBrowserNavigation(): BrowserNavigation {
  const empty: BrowserNavigation = { view: 'discovery', topicId: null, channelId: null, recentTopics: [], recentChannels: [] };
  try {
    const raw = window.localStorage.getItem(NAVIGATION_STORAGE_KEY);
    if (!raw) return empty;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return empty;
    const stored = value as Partial<BrowserNavigation>;
    const view = stored.view === 'topic' || stored.view === 'channel' || stored.view === 'leaderboard' ? stored.view : 'discovery';
    const recentChannels = normalizeRecentChannels(stored.recentChannels, RECENT_CHANNEL_LIMIT);
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
    recentTopics.sort((a, b) => a.visitedAt.localeCompare(b.visitedAt));
    recentChannels.sort((a, b) => a.visitedAt.localeCompare(b.visitedAt));
    return {
      view,
      topicId: typeof stored.topicId === 'string' ? stored.topicId : null,
      channelId: typeof stored.channelId === 'string' ? stored.channelId : null,
      recentTopics: recentTopics.slice(-RECENT_TOPIC_LIMIT),
      recentChannels: recentChannels.slice(-RECENT_CHANNEL_LIMIT),
    };
  } catch { return empty; }
}

export function readRecentChannelSnapshots(): RecentChannelDetails[] {
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
      .sort((a, b) => a.visitedAt.localeCompare(b.visitedAt))
      .slice(-6);
  } catch { return []; }
}

export function writeRecentChannelSnapshots(snapshots: RecentChannelDetails[]) {
  try { window.localStorage.setItem(RECENT_CHANNEL_CACHE_KEY, JSON.stringify(snapshots.slice(0, 6))); } catch { /* Storage is optional. */ }
}

export function recordFirstVisit<T extends { visitedAt: string }, K>(items: T[], item: T, getKey: (value: T) => K, limit: number): T[] {
  const key = getKey(item);
  const previous = items.find(current => getKey(current) === key);
  const next = [...items.filter(current => getKey(current) !== key), { ...item, visitedAt: previous?.visitedAt ?? item.visitedAt } as T];
  return next.sort((a, b) => a.visitedAt.localeCompare(b.visitedAt)).slice(-limit);
}

export function persistBrowserNavigation(navigation: BrowserNavigation) {
  try { window.localStorage.setItem(NAVIGATION_STORAGE_KEY, JSON.stringify(navigation)); } catch { /* Storage is optional. */ }
}
