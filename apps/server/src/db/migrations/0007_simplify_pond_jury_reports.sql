ALTER TABLE moderation_cases
  DROP COLUMN rule_code,
  DROP COLUMN rule_version;

ALTER TABLE moderation_reports
  DROP COLUMN rule_code;
