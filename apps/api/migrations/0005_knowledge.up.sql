-- Knowledge base for the AI receptionist.
--
-- Staff write "sources" (a titled piece of text). Only an APPROVED source is
-- ever split into searchable "chunks", so the AI can never use wording that a
-- person has not signed off: a source that is edited goes back to draft and its
-- chunks are removed until it is approved again.
--
-- Search is PostgreSQL full-text search (no outside service, nothing leaves the
-- database). A semantic (embedding) column can be added later behind the same
-- retriever interface.

CREATE TABLE knowledge_sources (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  practice_id uuid NOT NULL REFERENCES practices (id) ON DELETE RESTRICT,
  title       text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  category    text NOT NULL DEFAULT 'general'
              CHECK (category IN ('general', 'hours_location', 'services', 'insurance_billing', 'policies', 'faq')),
  content     text NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 20000),
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'archived')),
  version     integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by  uuid REFERENCES users (id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  approved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- An approved source records who approved it and when; nothing else does.
  CHECK ((status = 'approved') = (approved_at IS NOT NULL AND approved_by IS NOT NULL)),
  -- Lets chunks point at a source AND its practice together (see below).
  UNIQUE (id, practice_id)
);

CREATE INDEX knowledge_sources_practice_status_idx ON knowledge_sources (practice_id, status);

CREATE TRIGGER knowledge_sources_set_updated_at BEFORE UPDATE ON knowledge_sources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE knowledge_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_sources_tenant_isolation ON knowledge_sources
  USING (practice_id = app_current_practice_id())
  WITH CHECK (practice_id = app_current_practice_id());

-- ----------------------------------------------------------------- chunks
-- Only chunks of approved sources exist. The composite foreign key makes it
-- impossible for a chunk to belong to one practice and point at another
-- practice's source, even through a bug.

CREATE TABLE knowledge_chunks (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  practice_id uuid NOT NULL,
  source_id   uuid NOT NULL,
  ordinal     integer NOT NULL CHECK (ordinal >= 0),
  title       text NOT NULL,
  text        text NOT NULL CHECK (length(btrim(text)) > 0),
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || text)) STORED,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, ordinal),
  FOREIGN KEY (source_id, practice_id) REFERENCES knowledge_sources (id, practice_id) ON DELETE CASCADE
);

CREATE INDEX knowledge_chunks_tsv_idx ON knowledge_chunks USING gin (tsv);
CREATE INDEX knowledge_chunks_practice_idx ON knowledge_chunks (practice_id);

ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY knowledge_chunks_tenant_isolation ON knowledge_chunks
  USING (practice_id = app_current_practice_id())
  WITH CHECK (practice_id = app_current_practice_id());

-- ------------------------------------------------------------------ grants
-- No DELETE on sources: they are archived, not erased. Column-level UPDATE means
-- the API can never move a source to another practice or change who created it.

GRANT SELECT, INSERT ON knowledge_sources TO frontdesk_app;
GRANT UPDATE (title, category, content, status, version, approved_by, approved_at) ON knowledge_sources TO frontdesk_app;
GRANT SELECT, INSERT, DELETE ON knowledge_chunks TO frontdesk_app;
