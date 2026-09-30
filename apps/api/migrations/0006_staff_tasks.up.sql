-- Staff tasks: requests that need a person (call someone back, take a message).
-- Created by staff or, later, by the AI receptionist. Tasks are never deleted:
-- they are cancelled, so there is a record of every request.
--
-- The contact details are personal information, so access is limited by
-- permission and by row-level security like everything tenant-owned.

CREATE TABLE staff_tasks (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  practice_id     uuid NOT NULL REFERENCES practices (id) ON DELETE RESTRICT,
  type            text NOT NULL CHECK (type IN ('callback', 'message', 'question', 'other')),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  priority        text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'urgent')),
  title           text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  details         text CHECK (details IS NULL OR length(details) <= 4000),
  contact_name    text CHECK (contact_name IS NULL OR length(btrim(contact_name)) BETWEEN 1 AND 120),
  contact_phone   text CHECK (contact_phone IS NULL OR contact_phone ~ '^\+[1-9][0-9]{6,14}$'),
  created_by_type text NOT NULL CHECK (created_by_type IN ('user', 'ai')),
  created_by      uuid REFERENCES users (id) ON DELETE RESTRICT,
  assigned_to     uuid,
  due_at          timestamptz,
  completed_at    timestamptz,
  completed_by    uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- A staff-created task names its creator; an AI-created one never does.
  CHECK ((created_by_type = 'user') = (created_by IS NOT NULL)),
  -- Completion is recorded exactly when (and only when) the task is done.
  CHECK ((status = 'done') = (completed_at IS NOT NULL)),
  -- The assignee must belong to the SAME practice (a person of another practice cannot be assigned).
  FOREIGN KEY (practice_id, assigned_to) REFERENCES memberships (practice_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX staff_tasks_queue_idx ON staff_tasks (practice_id, status, created_at DESC, id DESC);
CREATE INDEX staff_tasks_assignee_idx ON staff_tasks (practice_id, assigned_to) WHERE assigned_to IS NOT NULL;

CREATE TRIGGER staff_tasks_set_updated_at BEFORE UPDATE ON staff_tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE staff_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_tasks_tenant_isolation ON staff_tasks
  USING (practice_id = app_current_practice_id())
  WITH CHECK (practice_id = app_current_practice_id());

-- No DELETE. Column-level UPDATE: a task can never be moved to another practice
-- or have its creator or type rewritten.
GRANT SELECT, INSERT ON staff_tasks TO frontdesk_app;
GRANT UPDATE (status, priority, title, details, contact_name, contact_phone, assigned_to, due_at, completed_at, completed_by)
  ON staff_tasks TO frontdesk_app;
