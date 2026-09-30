-- Conversations with the AI receptionist: the transcript, every tool call, and
-- what the AI did about it. Also marks who performed an audited action, so
-- actions by the AI receptionist are never confused with actions by a person.

-- ------------------------------------------------- audit: who acted (a person, the system, or the AI)
-- (Adding a column with a constant default does not rewrite rows, so the
-- append-only trigger on audit_logs is not involved.)

ALTER TABLE audit_logs ADD COLUMN actor_type text NOT NULL DEFAULT 'user'
  CHECK (actor_type IN ('user', 'system', 'ai'));
-- An action by the AI never names a user.
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_ai_has_no_user
  CHECK (actor_type <> 'ai' OR actor_user_id IS NULL);

-- ----------------------------------------------------------- conversations

CREATE TABLE conversations (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  practice_id       uuid NOT NULL REFERENCES practices (id) ON DELETE RESTRICT,
  channel           text NOT NULL CHECK (channel IN ('test_chat', 'phone')),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'handed_off', 'completed')),
  outcome           text CHECK (outcome IN ('answered', 'message_taken', 'handed_off', 'emergency', 'abandoned')),
  escalation        text CHECK (escalation IN ('urgent', 'emergency')),
  handoff_target_id uuid,
  started_by        uuid REFERENCES users (id) ON DELETE RESTRICT,   -- the staff member running a test chat
  model             text,                                            -- which model answered (for review and comparison)
  turn_count        integer NOT NULL DEFAULT 0 CHECK (turn_count >= 0),
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- A finished conversation records when it ended and how; an active one does neither.
  CHECK ((status = 'active') = (ended_at IS NULL AND outcome IS NULL)),
  UNIQUE (id, practice_id),
  FOREIGN KEY (handoff_target_id, practice_id) REFERENCES transfer_targets (id, practice_id) ON DELETE RESTRICT
);

CREATE INDEX conversations_practice_started_idx ON conversations (practice_id, started_at DESC, id DESC);

CREATE TRIGGER conversations_set_updated_at BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY conversations_tenant_isolation ON conversations
  USING (practice_id = app_current_practice_id())
  WITH CHECK (practice_id = app_current_practice_id());

-- ------------------------------------------------------------------- turns
-- One row per thing said. Never edited or deleted (the API role has no such rights).
-- "source" records HOW an AI line was produced, so reviewers can tell a model's
-- words from a fixed safety script.

CREATE TABLE conversation_turns (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  practice_id     uuid NOT NULL,
  conversation_id uuid NOT NULL,
  seq             integer NOT NULL CHECK (seq >= 1),
  speaker         text NOT NULL CHECK (speaker IN ('caller', 'ai', 'system')),
  source          text NOT NULL CHECK (source IN ('caller', 'greeting', 'model', 'scripted_emergency', 'scripted_urgent', 'scripted_guard', 'scripted_limit', 'system')),
  text            text NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  guard_reason    text,
  latency_ms      integer CHECK (latency_ms >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq),
  FOREIGN KEY (conversation_id, practice_id) REFERENCES conversations (id, practice_id) ON DELETE RESTRICT
);

ALTER TABLE conversation_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_turns_tenant_isolation ON conversation_turns
  USING (practice_id = app_current_practice_id())
  WITH CHECK (practice_id = app_current_practice_id());

-- -------------------------------------------------------- tool invocations
-- Every tool the AI asked for, with what it asked and what the backend answered,
-- including requests the backend refused.

CREATE TABLE tool_invocations (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  practice_id     uuid NOT NULL,
  conversation_id uuid NOT NULL,
  turn_seq        integer NOT NULL CHECK (turn_seq >= 1),   -- the caller turn that led to it
  tool_name       text NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 64),
  arguments       jsonb NOT NULL,
  result          jsonb,
  status          text NOT NULL CHECK (status IN ('ok', 'error', 'rejected')),
  duration_ms     integer CHECK (duration_ms >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, practice_id) REFERENCES conversations (id, practice_id) ON DELETE RESTRICT
);

CREATE INDEX tool_invocations_conversation_idx ON tool_invocations (conversation_id, created_at);

ALTER TABLE tool_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_invocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tool_invocations_tenant_isolation ON tool_invocations
  USING (practice_id = app_current_practice_id())
  WITH CHECK (practice_id = app_current_practice_id());

-- ------------------------------------------- tasks remember where they came from

ALTER TABLE staff_tasks ADD COLUMN conversation_id uuid;
ALTER TABLE staff_tasks ADD FOREIGN KEY (conversation_id, practice_id) REFERENCES conversations (id, practice_id) ON DELETE RESTRICT;
CREATE INDEX staff_tasks_conversation_idx ON staff_tasks (conversation_id) WHERE conversation_id IS NOT NULL;

-- ------------------------------------------------------------------ grants
-- Transcripts and tool calls are add-only for the API role.

GRANT SELECT, INSERT ON conversations TO frontdesk_app;
GRANT UPDATE (status, outcome, escalation, handoff_target_id, model, turn_count, ended_at) ON conversations TO frontdesk_app;
GRANT SELECT, INSERT ON conversation_turns TO frontdesk_app;
GRANT SELECT, INSERT ON tool_invocations TO frontdesk_app;
