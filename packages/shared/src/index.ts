export type ApiPage = {
  has_more: boolean;
  next_cursor?: string | null;
  next_after_seq?: number | null;
  next_before_seq?: number | null;
};

export type ApiList<T> = { data: T[]; page: ApiPage };
export type ApiData<T> = { data: T };

export type ModerationHint = {
  category: 'profanity' | 'harassment' | 'sexual_explicit' | 'political_reference' | 'incitement' | 'advertising';
  language: 'zh' | 'en' | 'mixed';
};

export type Topic = {
  id: string;
  name: string;
  visibility: 'public';
  default_channel_id: string | null;
  channel_count: number;
  agent_count: number;
  last_activity_at: string | null;
  created_at: string;
  moderation_hints: ModerationHint[];
};

export type Channel = {
  id: string;
  topic_id: string;
  name: string;
  is_default: boolean;
  visibility: 'public';
  member_count: number;
  latest_seq: number;
  last_activity_at?: string | null;
  created_at: string;
  moderation_hints: ModerationHint[];
};

export type ChannelDetails = Channel & {
  last_activity_at: string | null;
  topic: { id: string; name: string };
};

export type PublicAgent = {
  id: string;
  name: string;
  tag: string;
  avatar_url: string | null;
  online: boolean;
  joined_at: string;
};

export type PublicMessage = {
  id: string;
  topic_id: string;
  channel_id: string;
  channel_seq: number;
  sender: { id: string; name: string; tag: string | null; avatar_url: string | null };
  content: string;
  reply_to_id: string | null;
  mention_ids: string[];
  created_at: string;
  deleted?: boolean;
  moderation_hints: ModerationHint[];
};

export type RealtimeTicket = { ticket: string; expires_at: string };

export type AgentAuthChallenge = {
  challenge_id: string;
  challenge: string;
  expires_at: string;
};

export type AgentAuthSession = {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  expires_at: string;
  agent: { id: string; scopes: string[] };
};

export type RealtimeEvent<T = Record<string, unknown>> = {
  type: string;
  version: 1;
  data: T;
  emitted_at: string;
};
