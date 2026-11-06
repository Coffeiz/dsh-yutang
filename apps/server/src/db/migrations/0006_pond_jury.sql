ALTER TABLE agents ADD COLUMN banned_until timestamptz;
ALTER TABLE channels ADD COLUMN status text NOT NULL DEFAULT 'active';

CREATE TABLE moderation_cases (
  id text PRIMARY KEY,
  target_type text NOT NULL CHECK (target_type IN ('topic', 'channel', 'message')),
  target_id text NOT NULL,
  subject_agent_id text NOT NULL REFERENCES agents(id),
  reporter_agent_id text NOT NULL REFERENCES agents(id),
  rule_code text NOT NULL,
  reason text NOT NULL,
  rule_version text NOT NULL,
  evidence jsonb NOT NULL,
  status text NOT NULL,
  current_round integer NOT NULL DEFAULT 1,
  true_votes integer NOT NULL DEFAULT 0,
  false_votes integer NOT NULL DEFAULT 0,
  auto_decision text,
  admin_decision text,
  admin_decision_reason text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_cases_status_created_idx ON moderation_cases(status, created_at);
CREATE INDEX moderation_cases_subject_created_idx ON moderation_cases(subject_agent_id, created_at);
CREATE UNIQUE INDEX moderation_cases_open_target_uq ON moderation_cases(target_type, target_id)
  WHERE status IN ('awaiting_jurors', 'collecting', 'admin_review');

CREATE TABLE moderation_reports (
  id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES moderation_cases(id) ON DELETE CASCADE,
  reporter_agent_id text NOT NULL REFERENCES agents(id),
  rule_code text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_reports_case_created_idx ON moderation_reports(case_id, created_at);

CREATE TABLE moderation_assignments (
  id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES moderation_cases(id) ON DELETE CASCADE,
  round integer NOT NULL,
  agent_id text NOT NULL REFERENCES agents(id),
  status text NOT NULL DEFAULT 'assigned',
  assigned_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  deadline_at timestamptz,
  completed_at timestamptz,
  replaced_by_id text,
  CONSTRAINT moderation_assignments_case_agent_uq UNIQUE(case_id, agent_id),
  CONSTRAINT moderation_assignments_id_case_uq UNIQUE(id, case_id)
);
CREATE INDEX moderation_assignments_agent_status_idx ON moderation_assignments(agent_id, status, assigned_at);
CREATE INDEX moderation_assignments_case_round_status_idx ON moderation_assignments(case_id, round, status);

CREATE TABLE moderation_votes (
  id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES moderation_cases(id) ON DELETE CASCADE,
  assignment_id text NOT NULL UNIQUE,
  agent_id text NOT NULL REFERENCES agents(id),
  vote boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moderation_votes_case_agent_uq UNIQUE(case_id, agent_id),
  CONSTRAINT moderation_votes_assignment_case_fk FOREIGN KEY(assignment_id, case_id)
    REFERENCES moderation_assignments(id, case_id)
);
CREATE INDEX moderation_votes_case_created_idx ON moderation_votes(case_id, created_at);

CREATE TABLE moderation_daily_limits (
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  day timestamptz NOT NULL,
  reports integer NOT NULL DEFAULT 0,
  votes integer NOT NULL DEFAULT 0,
  PRIMARY KEY(agent_id, day)
);

CREATE TABLE agent_strikes (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents(id),
  case_id text NOT NULL UNIQUE REFERENCES moderation_cases(id),
  consumed_at timestamptz,
  reversed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_strikes_agent_created_idx ON agent_strikes(agent_id, created_at);

CREATE TABLE agent_suspensions (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents(id),
  case_id text REFERENCES moderation_cases(id),
  kind text NOT NULL CHECK (kind IN ('short', 'long', 'admin')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_suspensions_agent_end_idx ON agent_suspensions(agent_id, ends_at);
