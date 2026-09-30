-- Phone calls: which phone number belongs to which practice, and what a phone
-- conversation needs to remember.
--
-- A call arrives knowing only the number that was dialed, before any practice is
-- known. The practice is therefore found from that number, and from nothing else.

-- ------------------------------------------------------------ phone numbers
-- Added by the operator (a command), never by a practice itself: nobody can claim
-- another clinic's number. One number belongs to exactly one practice.

CREATE TABLE phone_numbers (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  practice_id  uuid NOT NULL REFERENCES practices (id) ON DELETE RESTRICT,
  e164         text NOT NULL CHECK (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  provider     text NOT NULL DEFAULT 'twilio' CHECK (provider IN ('twilio')),
  provider_sid text CHECK (provider_sid IS NULL OR length(provider_sid) BETWEEN 1 AND 64),
  label        text NOT NULL DEFAULT '' CHECK (length(label) <= 80),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (e164),
  -- Lets a conversation point at the number it was dialed on AND its practice together.
  UNIQUE (id, practice_id)
);

CREATE TRIGGER phone_numbers_set_updated_at BEFORE UPDATE ON phone_numbers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE phone_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE phone_numbers FORCE ROW LEVEL SECURITY;
CREATE POLICY phone_numbers_tenant_isolation ON phone_numbers
  USING (practice_id = app_current_practice_id())
  WITH CHECK (practice_id = app_current_practice_id());

-- A practice's people may READ their own numbers. They can never change them.
GRANT SELECT ON phone_numbers TO frontdesk_app;

-- ------------------------------------------- finding the practice for a call
-- Runs before any practice is known, so it cannot use the normal tenant rule. It
-- is deliberately narrow: given a number, it returns ONE thing, the id of the
-- practice that owns it, and only when both the number and the practice are
-- active. It cannot list numbers or reveal anything else.
-- (It runs with the schema owner's rights, which must be able to bypass row-level
-- security; see the production note in docs/architecture/authorization.md.)

CREATE FUNCTION resolve_practice_by_number(p_e164 text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT n.practice_id
    FROM phone_numbers n
    JOIN practices p ON p.id = n.practice_id
    WHERE n.e164 = p_e164 AND n.active AND p.status = 'active'
  $$;

REVOKE ALL ON FUNCTION resolve_practice_by_number(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_practice_by_number(text) TO frontdesk_app;

-- ------------------------------------------- what a phone conversation records
ALTER TABLE conversations ADD COLUMN provider_call_sid text
  CHECK (provider_call_sid IS NULL OR length(provider_call_sid) BETWEEN 1 AND 64);
ALTER TABLE conversations ADD COLUMN caller_number text
  CHECK (caller_number IS NULL OR caller_number ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE conversations ADD COLUMN phone_number_id uuid;
ALTER TABLE conversations ADD COLUMN duration_seconds integer
  CHECK (duration_seconds IS NULL OR duration_seconds >= 0);

ALTER TABLE conversations ADD FOREIGN KEY (phone_number_id, practice_id)
  REFERENCES phone_numbers (id, practice_id) ON DELETE RESTRICT;

-- One conversation per call, however many times the provider repeats a request.
CREATE UNIQUE INDEX conversations_provider_call_uq ON conversations (practice_id, provider_call_sid)
  WHERE provider_call_sid IS NOT NULL;

-- A phone conversation always knows which call it is.
ALTER TABLE conversations ADD CONSTRAINT conversations_phone_has_call_sid
  CHECK (channel <> 'phone' OR provider_call_sid IS NOT NULL);

GRANT UPDATE (duration_seconds) ON conversations TO frontdesk_app;
