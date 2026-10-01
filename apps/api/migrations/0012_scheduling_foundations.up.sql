-- Scheduling, step 1: who can be booked, for what, when, and the practice's booking
-- rules. Patients and appointments (with the no-double-booking guarantee) come in the
-- next step. Everything here is tenant-isolated like every other table: row-level
-- security, and composite foreign keys so nothing can point at another practice's rows.

-- --------------------------------------------------------- booking rules
-- One row per practice, created when someone first changes a rule (no row = the defaults).

CREATE TABLE scheduling_settings (
  practice_id        uuid PRIMARY KEY REFERENCES practices (id) ON DELETE RESTRICT,
  slot_minutes       integer NOT NULL DEFAULT 15 CHECK (slot_minutes IN (5, 10, 15, 20, 30, 60)),
  min_notice_hours   integer NOT NULL DEFAULT 2 CHECK (min_notice_hours BETWEEN 0 AND 720),
  max_advance_days   integer NOT NULL DEFAULT 60 CHECK (max_advance_days BETWEEN 1 AND 365),
  cancel_min_hours   integer NOT NULL DEFAULT 24 CHECK (cancel_min_hours BETWEEN 0 AND 720),
  -- The AI may book, cancel and move appointments only when a person has switched this on.
  ai_booking_enabled boolean NOT NULL DEFAULT false,
  updated_by         uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER scheduling_settings_set_updated_at BEFORE UPDATE ON scheduling_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE scheduling_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduling_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduling_settings_tenant_isolation ON scheduling_settings
  USING (practice_id = app_current_practice_id())
  WITH CHECK (practice_id = app_current_practice_id());

GRANT SELECT, INSERT ON scheduling_settings TO frontdesk_app;
GRANT UPDATE (slot_minutes, min_notice_hours, max_advance_days, cancel_min_hours, ai_booking_enabled, updated_by)
  ON scheduling_settings TO frontdesk_app;

-- -------------------------------------------------------------- providers
-- A doctor, nurse, therapist or room that can be booked. Never deleted: switched off.

CREATE TABLE providers (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  practice_id uuid NOT NULL REFERENCES practices (id) ON DELETE RESTRICT,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  title       text NOT NULL DEFAULT '' CHECK (length(title) <= 120),
  -- Weekly working hours in the practice's time zone, in the same shape as the practice's business hours.
  hours       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(hours) = 'object'),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, practice_id)
);

CREATE INDEX providers_practice_idx ON providers (practice_id, active, name);

CREATE TRIGGER providers_set_updated_at BEFORE UPDATE ON providers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE providers FORCE ROW LEVEL SECURITY;
CREATE POLICY providers_tenant_isolation ON providers
  USING (practice_id = app_current_practice_id())
  WITH CHECK (practice_id = app_current_practice_id());

GRANT SELECT, INSERT ON providers TO frontdesk_app;
GRANT UPDATE (name, title, hours, active) ON providers TO frontdesk_app;

-- ------------------------------------------------------ appointment types
-- "New patient visit, 40 minutes". Never deleted: switched off.

CREATE TABLE appointment_types (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  practice_id      uuid NOT NULL REFERENCES practices (id) ON DELETE RESTRICT,
  name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (practice_id, name),
  UNIQUE (id, practice_id)
);

CREATE TRIGGER appointment_types_set_updated_at BEFORE UPDATE ON appointment_types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE appointment_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_types FORCE ROW LEVEL SECURITY;
CREATE POLICY appointment_types_tenant_isolation ON appointment_types
  USING (practice_id = app_current_practice_id())
  WITH CHECK (practice_id = app_current_practice_id());

GRANT SELECT, INSERT ON appointment_types TO frontdesk_app;
GRANT UPDATE (name, duration_minutes, active) ON appointment_types TO frontdesk_app;

-- ------------------------------------------- which provider offers which type
-- Configuration, not history, so unlike the records elsewhere these links may be removed
-- (taking a type off a provider). Both ends must belong to the same practice.

CREATE TABLE provider_appointment_types (
  practice_id         uuid NOT NULL,
  provider_id         uuid NOT NULL,
  appointment_type_id uuid NOT NULL,
  PRIMARY KEY (provider_id, appointment_type_id),
  FOREIGN KEY (provider_id, practice_id) REFERENCES providers (id, practice_id) ON DELETE RESTRICT,
  FOREIGN KEY (appointment_type_id, practice_id) REFERENCES appointment_types (id, practice_id) ON DELETE RESTRICT
);

CREATE INDEX provider_appointment_types_type_idx ON provider_appointment_types (appointment_type_id);

ALTER TABLE provider_appointment_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_appointment_types FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_appointment_types_tenant_isolation ON provider_appointment_types
  USING (practice_id = app_current_practice_id())
  WITH CHECK (practice_id = app_current_practice_id());

GRANT SELECT, INSERT, DELETE ON provider_appointment_types TO frontdesk_app;

-- ---------------------------------------------------------------- time off
-- Holidays, leave, meetings: stretches when a provider cannot be booked. Cancelled, never deleted.

CREATE TABLE provider_time_off (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  practice_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  reason      text NOT NULL DEFAULT '' CHECK (length(reason) <= 200),
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  FOREIGN KEY (provider_id, practice_id) REFERENCES providers (id, practice_id) ON DELETE RESTRICT
);

CREATE INDEX provider_time_off_provider_idx ON provider_time_off (provider_id, starts_at, ends_at) WHERE active;

ALTER TABLE provider_time_off ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_time_off FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_time_off_tenant_isolation ON provider_time_off
  USING (practice_id = app_current_practice_id())
  WITH CHECK (practice_id = app_current_practice_id());

GRANT SELECT, INSERT ON provider_time_off TO frontdesk_app;
GRANT UPDATE (active) ON provider_time_off TO frontdesk_app;
