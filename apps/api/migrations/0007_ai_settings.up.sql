-- AI receptionist configuration: one settings row per practice, plus the phone
-- numbers a call may be handed to.
--
-- Safety rule enforced by the database itself: the AI can never be ON without a
-- greeting and an emergency message. (The API checks more and explains what is
-- missing; this is the guarantee that survives a bug.)

CREATE TABLE transfer_targets (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  practice_id uuid NOT NULL REFERENCES practices (id) ON DELETE RESTRICT,
  label       text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  phone       text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  purpose     text NOT NULL CHECK (purpose IN ('front_desk', 'on_call', 'billing', 'other')),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (practice_id, phone),
  -- Lets ai_settings point at a target AND its practice together (see below).
  UNIQUE (id, practice_id)
);

CREATE TRIGGER transfer_targets_set_updated_at BEFORE UPDATE ON transfer_targets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE transfer_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfer_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY transfer_targets_tenant_isolation ON transfer_targets
  USING (practice_id = app_current_practice_id())
  WITH CHECK (practice_id = app_current_practice_id());

CREATE TABLE ai_settings (
  practice_id                    uuid PRIMARY KEY REFERENCES practices (id) ON DELETE RESTRICT,
  enabled                        boolean NOT NULL DEFAULT false,
  greeting                       text NOT NULL DEFAULT '' CHECK (length(greeting) <= 500),
  after_hours_action             text NOT NULL DEFAULT 'take_message' CHECK (after_hours_action IN ('take_message', 'transfer')),
  after_hours_transfer_target_id uuid,
  emergency_message              text NOT NULL DEFAULT '' CHECK (length(emergency_message) <= 500),
  urgent_action                  text NOT NULL DEFAULT 'urgent_task' CHECK (urgent_action IN ('transfer', 'urgent_task', 'transfer_and_task')),
  urgent_transfer_target_id      uuid,
  extra_urgent_phrases           text[] NOT NULL DEFAULT '{}' CHECK (cardinality(extra_urgent_phrases) <= 30),
  business_hours                 jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(business_hours) = 'object'),
  updated_by                     uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now(),
  -- The AI is never on without something to say and a way to handle emergencies.
  CHECK (NOT enabled OR length(btrim(greeting)) > 0),
  CHECK (NOT enabled OR length(btrim(emergency_message)) > 0),
  -- A transfer target must belong to the same practice as the settings that use it.
  FOREIGN KEY (after_hours_transfer_target_id, practice_id) REFERENCES transfer_targets (id, practice_id) ON DELETE RESTRICT,
  FOREIGN KEY (urgent_transfer_target_id, practice_id) REFERENCES transfer_targets (id, practice_id) ON DELETE RESTRICT
);

CREATE TRIGGER ai_settings_set_updated_at BEFORE UPDATE ON ai_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_settings_tenant_isolation ON ai_settings
  USING (practice_id = app_current_practice_id())
  WITH CHECK (practice_id = app_current_practice_id());

-- No DELETE on either table: targets are deactivated and settings are switched off.
GRANT SELECT, INSERT ON transfer_targets TO frontdesk_app;
GRANT UPDATE (label, phone, purpose, active) ON transfer_targets TO frontdesk_app;
GRANT SELECT, INSERT ON ai_settings TO frontdesk_app;
GRANT UPDATE (enabled, greeting, after_hours_action, after_hours_transfer_target_id, emergency_message,
              urgent_action, urgent_transfer_target_id, extra_urgent_phrases, business_hours, updated_by)
  ON ai_settings TO frontdesk_app;
