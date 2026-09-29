-- Refresh-token sessions and the append-only audit log.

-- ---------------------------------------------------------- refresh_tokens
-- Only a SHA-256 hash of each token is stored. Tokens are rotated on every use;
-- family_id ties a chain of rotated tokens together so reuse of an old token
-- can revoke the whole family.

CREATE TABLE refresh_tokens (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  practice_id    uuid NOT NULL REFERENCES practices (id) ON DELETE CASCADE,
  family_id      uuid NOT NULL,
  token_hash     bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  replaced_by_id uuid REFERENCES refresh_tokens (id),
  created_ip     inet,
  user_agent     text CHECK (length(user_agent) <= 512),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_family_id_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens (user_id);

ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY refresh_tokens_tenant_isolation ON refresh_tokens
  USING (practice_id = app_current_practice_id())
  WITH CHECK (practice_id = app_current_practice_id());

-- -------------------------------------------------------------- audit_logs
-- practice_id is NULL for events that happen before a practice is known
-- (for example a failed login). Those rows are write-only for the API.

CREATE TABLE audit_logs (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  practice_id   uuid REFERENCES practices (id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  action        text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  target_type   text,
  target_id     text,
  request_id    text,
  ip            inet,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_practice_occurred_idx ON audit_logs (practice_id, occurred_at DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_read_own_practice ON audit_logs FOR SELECT
  USING (practice_id = app_current_practice_id());
CREATE POLICY audit_logs_insert ON audit_logs FOR INSERT
  WITH CHECK (practice_id IS NULL OR practice_id = app_current_practice_id());

-- Defence in depth: even a role that could otherwise change rows cannot edit
-- or remove audit history without first dropping these triggers (which is
-- itself a visible, deliberate act).
CREATE FUNCTION audit_logs_block_changes() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER audit_logs_no_update_delete BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_changes();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_block_changes();

-- ------------------------------------------------------------------ grants
GRANT SELECT, INSERT, UPDATE ON refresh_tokens TO frontdesk_app;
GRANT SELECT, INSERT ON audit_logs TO frontdesk_app;
