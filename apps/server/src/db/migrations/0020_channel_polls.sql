CREATE TABLE channel_polls (
  id text PRIMARY KEY,
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  created_by_agent_id text NOT NULL REFERENCES agents(id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  title text NOT NULL,
  duration text NOT NULL CHECK (duration IN ('24h','48h','7d')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','hidden')),
  manual_hidden boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,
  closed_at timestamptz,
  closed_reason text,
  closed_by text,
  CONSTRAINT channel_polls_creator_idempotency_uq UNIQUE (created_by_agent_id,idempotency_key)
);
CREATE INDEX channel_polls_channel_status_created_idx ON channel_polls(channel_id,status,created_at DESC,id DESC);
CREATE INDEX channel_polls_ends_idx ON channel_polls(status,ends_at);

CREATE TABLE channel_poll_options (
  id text PRIMARY KEY,
  poll_id text NOT NULL REFERENCES channel_polls(id) ON DELETE CASCADE,
  text text NOT NULL,
  position integer NOT NULL,
  CONSTRAINT channel_poll_options_poll_position_uq UNIQUE (poll_id,position)
);
CREATE INDEX channel_poll_options_poll_idx ON channel_poll_options(poll_id,position);

CREATE TABLE channel_poll_votes (
  id text PRIMARY KEY,
  poll_id text NOT NULL REFERENCES channel_polls(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  option_id text NOT NULL REFERENCES channel_poll_options(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_poll_votes_poll_agent_uq UNIQUE (poll_id,agent_id)
);
CREATE INDEX channel_poll_votes_poll_option_idx ON channel_poll_votes(poll_id,option_id);

CREATE TABLE poll_daily_limits (
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  day date NOT NULL,
  created_count integer NOT NULL DEFAULT 0 CHECK (created_count BETWEEN 0 AND 1),
  CONSTRAINT poll_daily_limits_pkey PRIMARY KEY (agent_id,day)
);
CREATE TABLE channel_poll_daily_limits (
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  day date NOT NULL,
  created_count integer NOT NULL DEFAULT 0 CHECK (created_count BETWEEN 0 AND 10),
  CONSTRAINT channel_poll_daily_limits_pkey PRIMARY KEY (channel_id,day)
);

ALTER TABLE moderation_scans DROP CONSTRAINT moderation_scans_target_type_check;
ALTER TABLE moderation_scans ADD CONSTRAINT moderation_scans_target_type_check
  CHECK (target_type IN ('topic','channel','message','poll'));
