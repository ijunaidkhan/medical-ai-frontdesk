-- Practice and member management.
--
-- The API runtime role gets exactly the write access these features need,
-- and no more. Column-level grants mean it can rename a practice but never
-- change its short name or status, and can change a member's role and status
-- but never who the member is or which practice they belong to. Row-level
-- security still confines every write to the current practice.

GRANT UPDATE (name, timezone, phone) ON practices TO frontdesk_app;
GRANT UPDATE (role, status) ON memberships TO frontdesk_app;

-- ------------------------------------------------------- keep an owner
-- A practice must always keep at least one active owner, or nobody could
-- manage it. The API also checks this, but the database guarantees it even
-- against future bugs and simultaneous requests: the remaining owners are
-- locked while checking, so two owners demoting each other at the same moment
-- are processed one after the other and the second is refused.

CREATE FUNCTION memberships_keep_an_owner() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.role = 'owner' AND OLD.status = 'active'
     AND (TG_OP = 'DELETE' OR NEW.role <> 'owner' OR NEW.status <> 'active') THEN
    PERFORM 1
    FROM memberships m
    WHERE m.practice_id = OLD.practice_id
      AND m.role = 'owner'
      AND m.status = 'active'
      AND m.id <> OLD.id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'a practice must keep at least one active owner'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER memberships_keep_an_owner BEFORE UPDATE OR DELETE ON memberships
  FOR EACH ROW EXECUTE FUNCTION memberships_keep_an_owner();
