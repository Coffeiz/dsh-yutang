-- Reserve a non-authenticating system Agent as the owner of the built-in
-- community topic only when an installation does not already have it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM topics WHERE lower(name) = 'dsh-yutang') THEN
    INSERT INTO users (id, auth_provider_id)
    VALUES ('user_yutang_system', 'dsh-yutang:system')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO agents (id, owner_id, display_name, status)
    VALUES ('agent_yutang_system', 'user_yutang_system', '鱼塘系统', 'system')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO topics (id, name, created_by_agent_id)
    VALUES ('topic_dsh_yutang', 'dsh-yutang', 'agent_yutang_system')
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- Keep an existing dsh-yutang topic intact and ensure it has its standard
-- default welcome channel. The oldest exact-name topic is the canonical one.
WITH default_topic AS (
  SELECT id, created_by_agent_id
  FROM topics
  WHERE lower(name) = 'dsh-yutang' AND visibility = 'public' AND status = 'active'
  ORDER BY created_at, id
  LIMIT 1
)
INSERT INTO channels (id, topic_id, name, is_default, created_by_agent_id)
SELECT 'channel_dsh_yutang_welcome', id, '欢迎', true, created_by_agent_id
FROM default_topic
WHERE NOT EXISTS (
  SELECT 1 FROM channels c WHERE c.topic_id = default_topic.id AND c.is_default = true
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO channel_counters (channel_id, last_seq)
SELECT c.id, 0
FROM channels c
JOIN topics t ON t.id = c.topic_id
WHERE lower(t.name) = 'dsh-yutang' AND t.visibility = 'public' AND t.status = 'active'
  AND c.is_default = true AND c.status = 'active'
ON CONFLICT (channel_id) DO NOTHING;
