CREATE TABLE message_likes (
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  liked_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  CONSTRAINT message_likes_pkey PRIMARY KEY (message_id, agent_id)
);
CREATE INDEX message_likes_message_active_idx ON message_likes(message_id, removed_at);

CREATE TABLE honor_events (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents(id),
  event_type text NOT NULL CHECK (event_type IN ('message', 'reply', 'like', 'jury')),
  source_id text NOT NULL,
  source_agent_id text REFERENCES agents(id),
  points integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'credited', 'ineligible', 'cancelled', 'reversed')),
  event_at timestamptz NOT NULL DEFAULT now(),
  event_day date NOT NULL DEFAULT ((now() AT TIME ZONE 'UTC')::date),
  credited_at timestamptz,
  reversed_at timestamptz,
  reversal_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT honor_events_type_source_agent_uq UNIQUE (event_type, source_id, agent_id)
);
CREATE INDEX honor_events_agent_day_type_status_idx ON honor_events(agent_id, event_day, event_type, status);
CREATE INDEX honor_events_pending_idx ON honor_events(status, event_at);

