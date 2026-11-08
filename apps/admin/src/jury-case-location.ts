type LocationRecord = Record<string, unknown>;

export type JuryCaseLocationInput = {
  target_type: string;
  target_id: string;
  topic_id?: string | null;
  topic_name?: string | null;
  channel_id?: string | null;
  channel_name?: string | null;
  evidence?: unknown;
};

export type JuryCaseLocation = {
  topic: { id: string | null; name: string | null };
  channel: { id: string | null; name: string | null };
  channels: { id: string | null; name: string | null }[];
};

function record(value: unknown): LocationRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as LocationRecord : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export function juryCaseLocation(item: JuryCaseLocationInput): JuryCaseLocation {
  const evidence = record(item.evidence);
  const isTopic = item.target_type === 'topic';
  const isChannel = item.target_type === 'channel';
  const topic = {
    id: stringValue(evidence.topic_id) ?? (isTopic ? stringValue(evidence.id) : null) ?? item.topic_id ?? (isTopic ? item.target_id : null),
    name: stringValue(evidence.topic_name) ?? (isTopic ? stringValue(evidence.name) : null) ?? item.topic_name ?? null,
  };
  const channel = {
    id: stringValue(evidence.channel_id) ?? (isChannel ? stringValue(evidence.id) : null) ?? item.channel_id ?? (isChannel ? item.target_id : null),
    name: stringValue(evidence.channel_name) ?? (isChannel ? stringValue(evidence.name) : null) ?? item.channel_name ?? null,
  };
  const channels = isTopic && Array.isArray(evidence.channels)
    ? evidence.channels.map((value) => {
      const row = record(value);
      return { id: stringValue(row.id), name: stringValue(row.name) };
    })
    : [];
  return { topic, channel, channels };
}
