-- Scheduling, step 2: patients and appointments. Tenant-isolated like everything else
-- (row-level security, composite foreign keys), never deleted (cancelled instead), and
-- the database itself refuses two overlapping appointments for one provider or one
-- patient, even when two requests arrive at the same instant.

-- Lets a plain column (the provider) and a time range share one exclusion constraint.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------- patients
-- Only what scheduling needs. Date of birth and phone are personal health information:
-- they are never written to logs or audit entries (identifiers only).

CREATE TABLE patients (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  practice_id     uuid NOT NULL REFERENCES practices (id) ON DELETE RESTRICT,
  first_name      text NOT NULL CHECK (length(btrim(first_name)) BETWEEN 1 AND 100),
  last_name       text NOT NULL CHECK (length(btrim(last_name)) BETWEEN 1 AND 100),
  date_of_birth   date NOT NULL CHECK (date_of_birth >= DATE '1900-01-01'),
  phone           text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  created_by_type text NOT NULL CHECK (created_by_type IN ('user', 'ai')),
  created_by      uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- A staff-created patient names its creator; an AI-created one never does.
  CHECK ((created_by_type = 'user') = (created_by IS NOT NULL)),
  UNIQUE (id, practice_id)
);

-- The same person (same name, date of birth and phone) exists once per practice.
CREATE UNIQUE INDEX patients_identity_unique
  ON patients (practice_id, lower(first_name), lower(last_name), date_of_birth, phone);
CREATE INDEX patients_last_name_idx ON patients (practice_id, lower(last_name) text_pattern_ops);
CREATE INDEX patients_first_name_idx ON patients (practice_id, lower(first_name) text_pattern_ops);

ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients FORCE ROW LEVEL SECURITY;
CREATE POLICY patients_tenant_isolation ON patients
  USING (practice_id = app_current_practice_id())
  WITH CHECK (practice_id = app_current_practice_id());

-- No UPDATE and no DELETE yet: a patient's details are not edited in this step.
GRANT SELECT, INSERT ON patients TO frontdesk_app;

-- ------------------------------------------------------------ appointments

CREATE TABLE appointments (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  practice_id         uuid NOT NULL,
  patient_id          uuid NOT NULL,
  provider_id         uuid NOT NULL,
  appointment_type_id uuid NOT NULL,
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  status              text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cancelled', 'completed', 'no_show')),
  booked_by_type      text NOT NULL CHECK (booked_by_type IN ('user', 'ai')),
  booked_by           uuid REFERENCES users (id) ON DELETE RESTRICT,
  -- When this appointment replaced one that was moved: the one it replaced.
  rescheduled_from_id uuid,
  -- Every booking carries one, so a retried request books once (see the unique index below).
  idempotency_key     text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  cancelled_at        timestamptz,
  cancelled_by_type   text CHECK (cancelled_by_type IN ('user', 'ai')),
  cancelled_by        uuid REFERENCES users (id) ON DELETE RESTRICT,
  cancel_reason       text NOT NULL DEFAULT '' CHECK (length(cancel_reason) <= 200),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK ((booked_by_type = 'user') = (booked_by IS NOT NULL)),
  -- Cancellation is recorded exactly when (and only when) the appointment is cancelled.
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((cancelled_at IS NULL) = (cancelled_by_type IS NULL)),
  CHECK (cancelled_by_type IS NULL OR (cancelled_by_type = 'user') = (cancelled_by IS NOT NULL)),
  UNIQUE (id, practice_id),
  CONSTRAINT appointments_idempotency_key_unique UNIQUE (practice_id, idempotency_key),
  FOREIGN KEY (patient_id, practice_id) REFERENCES patients (id, practice_id) ON DELETE RESTRICT,
  FOREIGN KEY (provider_id, practice_id) REFERENCES providers (id, practice_id) ON DELETE RESTRICT,
  FOREIGN KEY (appointment_type_id, practice_id) REFERENCES appointment_types (id, practice_id) ON DELETE RESTRICT,
  FOREIGN KEY (rescheduled_from_id, practice_id) REFERENCES appointments (id, practice_id) ON DELETE RESTRICT,
  -- No double booking: one provider cannot have two appointments overlapping in time, and one
  -- patient cannot be in two places at once. A cancelled appointment frees its time.
  CONSTRAINT appointments_provider_no_overlap
    EXCLUDE USING gist (provider_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status <> 'cancelled'),
  CONSTRAINT appointments_patient_no_overlap
    EXCLUDE USING gist (patient_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status <> 'cancelled')
);

CREATE INDEX appointments_calendar_idx ON appointments (practice_id, starts_at);
CREATE INDEX appointments_patient_idx ON appointments (patient_id, starts_at);

CREATE TRIGGER appointments_set_updated_at BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
CREATE POLICY appointments_tenant_isolation ON appointments
  USING (practice_id = app_current_practice_id())
  WITH CHECK (practice_id = app_current_practice_id());

-- No DELETE. An appointment is never edited in place except to change its status
-- (cancel); who, what and when were booked can never be rewritten.
GRANT SELECT, INSERT ON appointments TO frontdesk_app;
GRANT UPDATE (status, cancelled_at, cancelled_by_type, cancelled_by, cancel_reason)
  ON appointments TO frontdesk_app;
