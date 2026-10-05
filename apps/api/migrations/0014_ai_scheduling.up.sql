-- Scheduling, step 3: the AI receptionist books, lists, cancels and moves appointments.
-- Everything it does goes through the same backend rules as staff; this migration adds only
-- what the conversation itself needs to remember, and two practice settings.

-- ---------------------------------------------------------- practice settings
-- How times are written in sentences the system composes, and how many failed identity checks
-- per hour (all callers together) the AI tolerates before it stops identifying callers.

ALTER TABLE scheduling_settings ADD COLUMN time_format text NOT NULL DEFAULT '12h'
  CHECK (time_format IN ('12h', '24h'));
ALTER TABLE scheduling_settings ADD COLUMN identity_failure_cap_per_hour integer NOT NULL DEFAULT 30
  CHECK (identity_failure_cap_per_hour BETWEEN 5 AND 1000);

GRANT UPDATE (time_format, identity_failure_cap_per_hour) ON scheduling_settings TO frontdesk_app;

-- ------------------------------------------- what a conversation remembers
-- Who the caller has been verified as (all four details matched), and how many identity checks
-- have failed in this conversation. Three failures lock identification for the conversation: the
-- database refuses a fourth, so no bug can let a caller keep guessing.

ALTER TABLE conversations ADD COLUMN verified_patient_id uuid;
ALTER TABLE conversations ADD COLUMN identity_failures smallint NOT NULL DEFAULT 0
  CHECK (identity_failures BETWEEN 0 AND 3);
ALTER TABLE conversations ADD FOREIGN KEY (verified_patient_id, practice_id)
  REFERENCES patients (id, practice_id) ON DELETE RESTRICT;

GRANT UPDATE (verified_patient_id, identity_failures) ON conversations TO frontdesk_app;

-- ---------------------------------------- appointments remember which call made them

ALTER TABLE appointments ADD COLUMN conversation_id uuid;
ALTER TABLE appointments ADD FOREIGN KEY (conversation_id, practice_id)
  REFERENCES conversations (id, practice_id) ON DELETE RESTRICT;
CREATE INDEX appointments_conversation_idx ON appointments (conversation_id) WHERE conversation_id IS NOT NULL;

-- ------------------------------------- a sentence written by the backend, not the model

ALTER TABLE conversation_turns DROP CONSTRAINT conversation_turns_source_check;
ALTER TABLE conversation_turns ADD CONSTRAINT conversation_turns_source_check
  CHECK (source IN ('caller', 'greeting', 'model', 'scripted_emergency', 'scripted_urgent', 'scripted_guard', 'scripted_limit', 'scripted_booking', 'system'));

-- ------------------------------------------------- counting failed identity checks
-- "How many identity checks failed in the last hour in this practice" is asked on every check.

CREATE INDEX tool_invocations_verify_idx ON tool_invocations (practice_id, created_at DESC) WHERE tool_name = 'verify_patient';
