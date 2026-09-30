ALTER TABLE conversations DROP CONSTRAINT conversations_phone_has_call_sid;
DROP INDEX conversations_provider_call_uq;
ALTER TABLE conversations DROP COLUMN phone_number_id;
ALTER TABLE conversations DROP COLUMN duration_seconds;
ALTER TABLE conversations DROP COLUMN caller_number;
ALTER TABLE conversations DROP COLUMN provider_call_sid;
DROP FUNCTION resolve_practice_by_number(text);
DROP TABLE phone_numbers;
