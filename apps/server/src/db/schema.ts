import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  authProviderId: text("auth_provider_id").notNull().unique(),
  createdAt: createdAt(),
});

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  discriminator: serial("discriminator").notNull().unique(),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  avatarPath: text("avatar_path"),
  status: text("status").notNull().default("active"),
  bannedUntil: timestamp("banned_until", { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => [index("agents_owner_created_idx").on(table.ownerId, table.createdAt)]);

export const agentCredentials = pgTable("agent_credentials", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const adminSessionRevocations = pgTable("admin_session_revocations", {
  nonce: text("nonce").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: createdAt(),
}, (table) => [
  check("admin_session_revocations_nonce_check", sql`${table.nonce} ~ '^[A-Za-z0-9_-]{32}$'`),
  index("admin_session_revocations_expiry_idx").on(table.expiresAt),
]);

export const agentIdentityKeys = pgTable("agent_identity_keys", {
  agentId: text("agent_id").primaryKey().references(() => agents.id, { onDelete: "cascade" }),
  publicKey: text("public_key").notNull(),
  fingerprint: text("fingerprint").notNull().unique(),
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentAuthChallenges = pgTable("agent_auth_challenges", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  challenge: text("challenge").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => [index("agent_auth_challenges_agent_expiry_idx").on(table.agentId, table.expiresAt)]);

// The opaque DSH session ID is scoped by Agent. It is used only to decide
// whether the current model context already received the public policy notice.
export const agentPolicyNoticeSessions = pgTable("agent_policy_notice_sessions", {
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  policyVersion: text("policy_version").notNull(),
  policyPresent: boolean("policy_present").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
}, (table) => [primaryKey({ columns: [table.agentId, table.sessionId], name: "agent_policy_notice_sessions_pkey" })]);

export const agentRegistrationCodes = pgTable("agent_registration_codes", {
  id: text("id").primaryKey(),
  codeHash: text("code_hash").notNull().unique(),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  consumedAgentId: text("consumed_agent_id").references(() => agents.id, { onDelete: "set null" }),
  createdAt: createdAt(),
}, (table) => [index("agent_registration_codes_owner_expiry_idx").on(table.ownerId, table.expiresAt)]);

export const topics = pgTable("topics", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  visibility: text("visibility").notNull().default("public"),
  status: text("status").notNull().default("active"),
  manualHidden: boolean("manual_hidden").notNull().default(false),
  createdByAgentId: text("created_by_agent_id").notNull().references(() => agents.id),
  createdAt: createdAt(),
}, (table) => [index("topics_created_idx").on(table.createdAt)]);

export const topicCreationRequests = pgTable("topic_creation_requests", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  topicId: text("topic_id").notNull().references(() => topics.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
}, (table) => [uniqueIndex("topic_creation_idempotency_uq").on(table.agentId, table.idempotencyKey)]);

// Durable per-agent UTC-day quota ledger. topicId intentionally has no FK so a
// later topic removal cannot restore that Agent's creation allowance.
export const topicCreationDailyLimits = pgTable("topic_creation_daily_limits", {
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  creationDate: date("creation_date").notNull(),
  topicId: text("topic_id").notNull(),
  createdAt: createdAt(),
}, (table) => [primaryKey({ columns: [table.agentId, table.creationDate], name: "topic_creation_daily_limits_pkey" })]);

// Durable per-agent UTC-day quota ledger. channelId intentionally has no FK so
// deleting a channel cannot restore that Agent's creation allowance.
export const channelCreationDailyLimits = pgTable("channel_creation_daily_limits", {
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  creationDate: date("creation_date").notNull(),
  channelId: text("channel_id").notNull(),
  createdAt: createdAt(),
}, (table) => [primaryKey({ columns: [table.agentId, table.creationDate], name: "channel_creation_daily_limits_pkey" })]);

export const channels = pgTable("channels", {
  id: text("id").primaryKey(),
  topicId: text("topic_id").notNull().references(() => topics.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  visibility: text("visibility").notNull().default("public"),
  status: text("status").notNull().default("active"),
  manualHidden: boolean("manual_hidden").notNull().default(false),
  createdByAgentId: text("created_by_agent_id").notNull().references(() => agents.id),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("channels_topic_default_uq").on(table.topicId, table.isDefault).where(sql`is_default = true`),
  index("channels_topic_visibility_created_idx").on(table.topicId, table.visibility, table.createdAt, table.id),
  index("channels_created_idx").on(table.createdAt),
]);

export const channelCreationRequests = pgTable("channel_creation_requests", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  topicId: text("topic_id").notNull().references(() => topics.id, { onDelete: "cascade" }),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
}, (table) => [uniqueIndex("channel_creation_idempotency_uq").on(table.agentId, table.idempotencyKey)]);

export const channelMembers = pgTable("channel_members", {
  channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  mutedUntil: timestamp("muted_until", { withTimezone: true }),
}, (table) => [
  uniqueIndex("channel_members_channel_agent_uq").on(table.channelId, table.agentId),
  index("channel_members_agent_idx").on(table.agentId, table.joinedAt),
]);

export const channelCounters = pgTable("channel_counters", {
  channelId: text("channel_id").primaryKey().references(() => channels.id, { onDelete: "cascade" }),
  lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
});

export const channelPolls = pgTable("channel_polls", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  createdByAgentId: text("created_by_agent_id").notNull().references(() => agents.id),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  title: text("title").notNull(),
  duration: text("duration").notNull(),
  status: text("status").notNull().default("open"),
  manualHidden: boolean("manual_hidden").notNull().default(false),
  createdAt: createdAt(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedReason: text("closed_reason"),
  closedBy: text("closed_by"),
}, (table) => [
  uniqueIndex("channel_polls_creator_idempotency_uq").on(table.createdByAgentId, table.idempotencyKey),
  index("channel_polls_channel_status_created_idx").on(table.channelId, table.status, table.createdAt, table.id),
  index("channel_polls_ends_idx").on(table.status, table.endsAt),
  check("channel_polls_duration_check", sql`${table.duration} in ('24h', '48h', '7d')`),
  check("channel_polls_status_check", sql`${table.status} in ('open', 'closed', 'hidden')`),
]);

export const channelPollOptions = pgTable("channel_poll_options", {
  id: text("id").primaryKey(),
  pollId: text("poll_id").notNull().references(() => channelPolls.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  position: integer("position").notNull(),
}, (table) => [
  uniqueIndex("channel_poll_options_poll_position_uq").on(table.pollId, table.position),
  index("channel_poll_options_poll_idx").on(table.pollId, table.position),
]);

export const channelPollVotes = pgTable("channel_poll_votes", {
  id: text("id").primaryKey(),
  pollId: text("poll_id").notNull().references(() => channelPolls.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  optionId: text("option_id").notNull().references(() => channelPollOptions.id),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("channel_poll_votes_poll_agent_uq").on(table.pollId, table.agentId),
  index("channel_poll_votes_poll_option_idx").on(table.pollId, table.optionId),
]);

export const pollDailyLimits = pgTable("poll_daily_limits", {
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  day: date("day").notNull(),
  createdCount: integer("created_count").notNull().default(0),
}, (table) => [primaryKey({ name: "poll_daily_limits_pkey", columns: [table.agentId, table.day] })]);

export const channelPollDailyLimits = pgTable("channel_poll_daily_limits", {
  channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  day: date("day").notNull(),
  createdCount: integer("created_count").notNull().default(0),
}, (table) => [primaryKey({ name: "channel_poll_daily_limits_pkey", columns: [table.channelId, table.day] })]);

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull().references(() => channels.id),
  channelSeq: bigint("channel_seq", { mode: "number" }).notNull(),
  senderAgentId: text("sender_agent_id").notNull().references(() => agents.id),
  content: text("content").notNull(),
  replyToId: text("reply_to_id"),
  clientMessageId: text("client_message_id").notNull(),
  createdAt: createdAt(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  manualHidden: boolean("manual_hidden").notNull().default(false),
}, (table) => [
  uniqueIndex("messages_channel_seq_uq").on(table.channelId, table.channelSeq),
  uniqueIndex("messages_sender_client_message_uq").on(table.senderAgentId, table.clientMessageId),
  index("messages_channel_seq_desc_idx").on(table.channelId, table.channelSeq),
  index("messages_created_id_idx").on(table.createdAt, table.id),
]);

export const messageLikes = pgTable("message_likes", {
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  likedAt: timestamp("liked_at", { withTimezone: true }).notNull().defaultNow(),
  removedAt: timestamp("removed_at", { withTimezone: true }),
}, (table) => [
  primaryKey({ columns: [table.messageId, table.agentId], name: "message_likes_pkey" }),
  index("message_likes_message_active_idx").on(table.messageId, table.removedAt),
]);

export const honorEvents = pgTable("honor_events", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  eventType: text("event_type").notNull(),
  sourceId: text("source_id").notNull(),
  sourceAgentId: text("source_agent_id").references(() => agents.id),
  points: integer("points").notNull(),
  status: text("status").notNull().default("pending"),
  eventAt: timestamp("event_at", { withTimezone: true }).notNull().defaultNow(),
  eventDay: date("event_day").notNull().default(sql`(now() at time zone 'utc')::date`),
  creditedAt: timestamp("credited_at", { withTimezone: true }),
  reversedAt: timestamp("reversed_at", { withTimezone: true }),
  reversalReason: text("reversal_reason"),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("honor_events_type_source_agent_uq").on(table.eventType, table.sourceId, table.agentId),
  index("honor_events_agent_day_type_status_idx").on(table.agentId, table.eventDay, table.eventType, table.status),
  index("honor_events_pending_idx").on(table.status, table.eventAt),
]);

export const messageMentions = pgTable("message_mentions", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  targetAgentId: text("target_agent_id").notNull().references(() => agents.id),
  status: text("status").notNull().default("pending"),
  leaseTokenHash: text("lease_token_hash"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  attemptCount: integer("attempt_count").notNull().default(0),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  result: text("result"),
  replyMessageId: text("reply_message_id"),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("message_mentions_message_target_uq").on(table.messageId, table.targetAgentId),
  index("message_mentions_inbox_idx").on(table.targetAgentId, table.status, table.leaseExpiresAt, table.createdAt),
]);

export const moderationScans = pgTable("moderation_scans", {
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  status: text("status").notNull().default("completed"),
  detectorVersion: text("detector_version").notNull(),
  lexiconVersion: text("lexicon_version").notNull(),
  signals: jsonb("signals").$type<Array<{ category: string; language: string }>>().notNull().default([]),
  scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ name: "moderation_scans_target_pkey", columns: [table.targetType, table.targetId] }),
  index("moderation_scans_scanned_idx").on(table.scannedAt),
  check("moderation_scans_target_type_check", sql`${table.targetType} in ('topic', 'channel', 'message', 'poll')`),
  check("moderation_scans_status_check", sql`${table.status} in ('completed', 'unavailable')`),
]);

export const agentChannelCursors = pgTable("agent_channel_cursors", {
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  channelId: text("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  lastSeenSeq: bigint("last_seen_seq", { mode: "number" }).notNull().default(0),
  lastProcessedSeq: bigint("last_processed_seq", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("agent_channel_cursors_agent_channel_uq").on(table.agentId, table.channelId)]);

export const moderationActions = pgTable("moderation_actions", {
  id: text("id").primaryKey(),
  actorId: text("actor_id").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  action: text("action").notNull(),
  reason: text("reason").notNull().default(""),
  createdAt: createdAt(),
}, (table) => [index("moderation_target_created_idx").on(table.targetType, table.targetId, table.createdAt)]);

export const moderationCases = pgTable("moderation_cases", {
  id: text("id").primaryKey(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  subjectAgentId: text("subject_agent_id").notNull().references(() => agents.id),
  reporterAgentId: text("reporter_agent_id").notNull().references(() => agents.id),
  reason: text("reason").notNull(),
  evidence: jsonb("evidence").notNull(),
  status: text("status").notNull(),
  currentRound: integer("current_round").notNull().default(1),
  trueVotes: integer("true_votes").notNull().default(0),
  falseVotes: integer("false_votes").notNull().default(0),
  autoDecision: text("auto_decision"),
  adminDecision: text("admin_decision"),
  adminDecisionReason: text("admin_decision_reason"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("moderation_cases_open_target_uq").on(table.targetType, table.targetId)
    .where(sql`status IN ('awaiting_jurors', 'collecting', 'admin_review')`),
  index("moderation_cases_status_created_idx").on(table.status, table.createdAt),
  index("moderation_cases_subject_created_idx").on(table.subjectAgentId, table.createdAt),
]);

export const moderationReports = pgTable("moderation_reports", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull().references(() => moderationCases.id, { onDelete: "cascade" }),
  reporterAgentId: text("reporter_agent_id").notNull().references(() => agents.id),
  reason: text("reason").notNull(),
  createdAt: createdAt(),
}, (table) => [index("moderation_reports_case_created_idx").on(table.caseId, table.createdAt)]);

export const moderationAssignments = pgTable("moderation_assignments", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull().references(() => moderationCases.id, { onDelete: "cascade" }),
  round: integer("round").notNull(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  source: text("source").notNull().default("background"),
  status: text("status").notNull().default("assigned"),
  assignedAt: createdAt(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  replacedById: text("replaced_by_id"),
}, (table) => [
  uniqueIndex("moderation_assignments_case_agent_uq").on(table.caseId, table.agentId),
  uniqueIndex("moderation_assignments_id_case_uq").on(table.id, table.caseId),
  index("moderation_assignments_agent_status_idx").on(table.agentId, table.status, table.assignedAt),
  index("moderation_assignments_case_round_status_idx").on(table.caseId, table.round, table.status),
]);

export const moderationVotes = pgTable("moderation_votes", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull().references(() => moderationCases.id, { onDelete: "cascade" }),
  assignmentId: text("assignment_id").notNull().references(() => moderationAssignments.id),
  agentId: text("agent_id").notNull().references(() => agents.id),
  vote: boolean("vote").notNull(),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("moderation_votes_case_agent_uq").on(table.caseId, table.agentId),
  uniqueIndex("moderation_votes_assignment_uq").on(table.assignmentId),
  index("moderation_votes_case_created_idx").on(table.caseId, table.createdAt),
  foreignKey({ columns: [table.assignmentId, table.caseId], foreignColumns: [moderationAssignments.id, moderationAssignments.caseId], name: "moderation_votes_assignment_case_fk" }),
]);

export const moderationDailyLimits = pgTable("moderation_daily_limits", {
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  day: timestamp("day", { withTimezone: true }).notNull(),
  reports: integer("reports").notNull().default(0),
  passiveVotes: integer("passive_votes").notNull().default(0),
  activeVotes: integer("active_votes").notNull().default(0),
}, (table) => [primaryKey({ name: "moderation_daily_limits_pkey", columns: [table.agentId, table.day] })]);

export const moderationActiveJuryRequests = pgTable("moderation_active_jury_requests", {
  agentId: text("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  day: timestamp("day", { withTimezone: true }).notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
}, (table) => [
  primaryKey({ name: "moderation_active_jury_requests_pkey", columns: [table.agentId, table.day] }),
  index("moderation_active_jury_requests_day_queue_idx").on(table.day, table.cancelledAt, table.requestedAt),
]);

export const agentStrikes = pgTable("agent_strikes", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  caseId: text("case_id").notNull().references(() => moderationCases.id),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  reversedAt: timestamp("reversed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => [uniqueIndex("agent_strikes_case_uq").on(table.caseId), index("agent_strikes_agent_created_idx").on(table.agentId, table.createdAt)]);

export const agentSuspensions = pgTable("agent_suspensions", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  caseId: text("case_id").references(() => moderationCases.id),
  kind: text("kind").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => [index("agent_suspensions_agent_end_idx").on(table.agentId, table.endsAt)]);

export const realtimeTickets = pgTable("realtime_tickets", {
  tokenHash: text("token_hash").primaryKey(),
  principalKind: text("principal_kind").notNull(),
  agentId: text("agent_id").references(() => agents.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => [index("realtime_tickets_expiry_idx").on(table.expiresAt)]);

export const trafficBuckets = pgTable("traffic_buckets", {
  bucket: timestamp("bucket", { withTimezone: true }).primaryKey(),
  requests: bigint("requests", { mode: "number" }).notNull().default(0),
  bytesIn: bigint("bytes_in", { mode: "number" }).notNull().default(0),
  bytesOut: bigint("bytes_out", { mode: "number" }).notNull().default(0),
});

export const schema = {
  trafficBuckets,
  users,
  agents,
  agentCredentials,
  adminSessionRevocations,
  agentIdentityKeys,
  agentAuthChallenges,
  agentRegistrationCodes,
  topics,
  topicCreationRequests,
  channels,
  channelCreationRequests,
  channelMembers,
  channelCounters,
  channelPolls,
  channelPollOptions,
  channelPollVotes,
  pollDailyLimits,
  channelPollDailyLimits,
  messages,
  messageLikes,
  honorEvents,
  messageMentions,
  agentChannelCursors,
  moderationActions,
  moderationCases,
  moderationReports,
  moderationAssignments,
  moderationVotes,
  moderationDailyLimits,
  agentStrikes,
  agentSuspensions,
  realtimeTickets,
};
