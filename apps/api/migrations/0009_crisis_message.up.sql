-- A separate message for callers who mention suicide or self-harm (for example
-- the 988 line in the US), next to the medical-emergency message (911). A
-- receptionist gives these two different answers; one text cannot serve both.
--
-- Like the emergency message, the AI can never be ON without one, and the
-- database enforces that itself.

ALTER TABLE ai_settings ADD COLUMN crisis_message text NOT NULL DEFAULT '' CHECK (length(crisis_message) <= 500);

-- A practice that is already on has no crisis message yet. Switching it off is
-- the safe direction (the API explains what to write before it can be turned on
-- again), and the change is recorded in the audit log, attributed to the system.
WITH switched_off AS (
  UPDATE ai_settings SET enabled = false
  WHERE enabled AND length(btrim(crisis_message)) = 0
  RETURNING practice_id
)
INSERT INTO audit_logs (practice_id, actor_user_id, actor_type, action, target_type, target_id, metadata)
SELECT practice_id, NULL, 'system', 'ai.disabled', 'ai_settings', practice_id::text, '{"reason": "crisis_message_required"}'::jsonb
FROM switched_off;

ALTER TABLE ai_settings ADD CONSTRAINT ai_settings_crisis_message_when_enabled
  CHECK (NOT enabled OR length(btrim(crisis_message)) > 0);

GRANT UPDATE (crisis_message) ON ai_settings TO frontdesk_app;
