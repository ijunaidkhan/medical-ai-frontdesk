-- When the safety check replaces what the AI model wrote (a diagnosis, a false booking
-- claim, code instead of words...), the caller hears a fixed safe line instead. Until
-- now the model's own words were thrown away, which made it impossible to tell WHY a
-- reply was blocked or whether the check was right. They are kept now, with the turn
-- they replaced, for people allowed to read conversations (calls:read).
--
-- The text is the model's output and may repeat what the caller said, so it lives in the
-- same protected table as the transcript, with the same tenant isolation and no way to
-- edit or delete it. It is NEVER spoken or shown to the caller.

ALTER TABLE conversation_turns ADD COLUMN blocked_text text
  CHECK (blocked_text IS NULL OR length(blocked_text) BETWEEN 1 AND 4000);

-- Only a turn that was actually replaced has one.
ALTER TABLE conversation_turns ADD CONSTRAINT conversation_turns_blocked_text_needs_reason
  CHECK (blocked_text IS NULL OR guard_reason IS NOT NULL);
