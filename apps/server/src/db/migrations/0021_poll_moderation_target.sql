ALTER TABLE moderation_cases DROP CONSTRAINT moderation_cases_target_type_check;
--> statement-breakpoint
ALTER TABLE moderation_cases ADD CONSTRAINT moderation_cases_target_type_check
  CHECK (target_type IN ('topic', 'channel', 'message', 'poll'));
