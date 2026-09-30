DROP INDEX staff_tasks_conversation_idx;
ALTER TABLE staff_tasks DROP COLUMN conversation_id;
DROP TABLE tool_invocations;
DROP TABLE conversation_turns;
DROP TABLE conversations;
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_ai_has_no_user;
ALTER TABLE audit_logs DROP COLUMN actor_type;
