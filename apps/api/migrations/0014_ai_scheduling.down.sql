DROP INDEX tool_invocations_verify_idx;

-- Lines written by the backend go back to being marked as fixed safe lines, so the older check accepts them.
UPDATE conversation_turns SET source = 'scripted_guard' WHERE source = 'scripted_booking';
ALTER TABLE conversation_turns DROP CONSTRAINT conversation_turns_source_check;
ALTER TABLE conversation_turns ADD CONSTRAINT conversation_turns_source_check
  CHECK (source IN ('caller', 'greeting', 'model', 'scripted_emergency', 'scripted_urgent', 'scripted_guard', 'scripted_limit', 'system'));

DROP INDEX appointments_conversation_idx;
ALTER TABLE appointments DROP COLUMN conversation_id;

ALTER TABLE conversations DROP COLUMN identity_failures;
ALTER TABLE conversations DROP COLUMN verified_patient_id;

ALTER TABLE scheduling_settings DROP COLUMN identity_failure_cap_per_hour;
ALTER TABLE scheduling_settings DROP COLUMN time_format;
