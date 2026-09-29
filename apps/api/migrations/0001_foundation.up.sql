-- Foundation: tenant model (a practice IS the tenant), users, memberships.
--
-- Tenant isolation is enforced in the database with row-level security (RLS),
-- in addition to the checks in application code. The API sets the current
-- practice per transaction (see src/database/practice-context.ts). If it is
-- not set, the policies match nothing, so queries return zero rows.
--
-- This migration is run by the schema owner (frontdesk_owner). The API runtime
-- role frontdesk_app is created by infra/docker/postgres/init and only receives
-- the minimal grants listed below.

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------- helpers

CREATE FUNCTION app_current_practice_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.practice_id', true), '')::uuid $$;

CREATE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;

-- --------------------------------------------------------------- practices
-- The tenant root. Each practice is fully isolated from every other.

CREATE TABLE practices (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  name       text NOT NULL CHECK (length(btrim(name)) > 0),
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  timezone   text NOT NULL DEFAULT 'UTC',
  phone      text,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER practices_set_updated_at BEFORE UPDATE ON practices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE practices ENABLE ROW LEVEL SECURITY;
ALTER TABLE practices FORCE ROW LEVEL SECURITY;
CREATE POLICY practices_tenant_isolation ON practices
  USING (id = app_current_practice_id())
  WITH CHECK (id = app_current_practice_id());

-- ------------------------------------------------------------------- users
-- Global identities: one person can belong to several practices. Credentials
-- are only reachable by the API through narrow functions added with the auth
-- milestone, never by listing this table.

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  email              citext NOT NULL UNIQUE CHECK (length(email) <= 254),
  password_hash      text NOT NULL,
  display_name       text NOT NULL CHECK (length(btrim(display_name)) > 0),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until       timestamptz,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
-- The users policy is created after memberships exists (see below).

-- ------------------------------------------------------------- memberships
-- Links a user to a practice and carries the role they hold there.

CREATE TABLE memberships (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  practice_id uuid NOT NULL REFERENCES practices (id) ON DELETE RESTRICT,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  role        text NOT NULL CHECK (role IN ('owner', 'admin', 'staff', 'viewer')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (practice_id, user_id)
);

CREATE INDEX memberships_user_id_idx ON memberships (user_id);

CREATE TRIGGER memberships_set_updated_at BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_tenant_isolation ON memberships
  USING (practice_id = app_current_practice_id())
  WITH CHECK (practice_id = app_current_practice_id());

-- A request may see itself, and the members of the practice it is acting in
-- (the memberships subquery is itself filtered by the memberships policy).
CREATE POLICY users_visible_in_context ON users FOR SELECT
  USING (
    id = app_current_user_id()
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id)
  );

-- ------------------------------------------------------------------ grants
-- Least privilege for the API runtime role. Later migrations add more only
-- when a feature needs it.

GRANT USAGE ON SCHEMA public TO frontdesk_app;
GRANT EXECUTE ON FUNCTION app_current_practice_id(), app_current_user_id() TO frontdesk_app;
GRANT SELECT ON practices, users, memberships TO frontdesk_app;
