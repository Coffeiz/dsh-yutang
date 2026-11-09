ALTER TABLE moderation_assignments
  ADD COLUMN source text NOT NULL DEFAULT 'background';
ALTER TABLE moderation_assignments
  ADD CONSTRAINT moderation_assignments_source_check
  CHECK (source IN ('background', 'active_request'));

ALTER TABLE moderation_daily_limits RENAME COLUMN votes TO passive_votes;
ALTER TABLE moderation_daily_limits
  ADD COLUMN active_votes integer NOT NULL DEFAULT 0;

CREATE TABLE moderation_active_jury_requests (
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  day timestamptz NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  CONSTRAINT moderation_active_jury_requests_pkey PRIMARY KEY (agent_id, day)
);
CREATE INDEX moderation_active_jury_requests_day_queue_idx
  ON moderation_active_jury_requests(day, cancelled_at, requested_at);
