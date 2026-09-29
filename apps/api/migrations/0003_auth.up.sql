-- Authentication support.
--
-- Login has to work BEFORE a practice is known, but row-level security hides
-- users and memberships until one is. Rather than weakening the policies, the
-- API gets a few narrow SECURITY DEFINER functions that do exactly one thing
-- each. They run with the owner's rights, so each one:
--   * pins search_path (prevents hijacking via objects in other schemas),
--   * is revoked from PUBLIC and granted only to the API runtime role.

-- ----------------------------------------------------- session hard limit
-- Refresh tokens rotate on every use; this carries the absolute end of the
-- session through each rotation so a session cannot be extended forever.

ALTER TABLE refresh_tokens ADD COLUMN session_expires_at timestamptz;
UPDATE refresh_tokens SET session_expires_at = expires_at;
ALTER TABLE refresh_tokens ALTER COLUMN session_expires_at SET NOT NULL;
ALTER TABLE refresh_tokens ADD CONSTRAINT refresh_tokens_expiry_within_session
  CHECK (expires_at <= session_expires_at);

-- ------------------------------------------------------ user lookup (login)

CREATE FUNCTION auth_find_user_by_email(p_email citext)
  RETURNS TABLE (id uuid, password_hash text, status text, is_locked boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT u.id, u.password_hash, u.status, coalesce(u.locked_until > now(), false)
    FROM users u
    WHERE u.email = p_email
  $$;

-- ------------------------------------------------ failed login and lockout
-- Lockout policy: after 5 consecutive failures the account locks for 1 minute,
-- doubling with each further failure up to 1 hour. Failures while locked are
-- not counted. A NULL user id (unknown email) updates nothing; the API still
-- calls it so both cases do the same database work (no timing difference).

CREATE FUNCTION auth_record_login_failure(p_user_id uuid)
  RETURNS TABLE (failed_login_count integer, locked_until timestamptz)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    UPDATE users u
    SET failed_login_count = u.failed_login_count + 1,
        locked_until = CASE
          WHEN u.failed_login_count + 1 >= 5
            THEN now() + least(
              interval '1 minute' * power(2, least(u.failed_login_count + 1 - 5, 10)),
              interval '1 hour')
          ELSE u.locked_until
        END
    WHERE u.id = p_user_id
      AND (u.locked_until IS NULL OR u.locked_until <= now())
    RETURNING u.failed_login_count, u.locked_until
  $$;

CREATE FUNCTION auth_record_login_success(p_user_id uuid)
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    UPDATE users
    SET failed_login_count = 0, locked_until = NULL, last_login_at = now()
    WHERE id = p_user_id
  $$;

-- ------------------------------------------------ practices a user can use
-- Only active memberships in active practices, for choosing / switching the
-- practice a session acts in. Callers must pass an already-authenticated id.

CREATE FUNCTION auth_list_user_practices(p_user_id uuid)
  RETURNS TABLE (practice_id uuid, name text, slug text, timezone text, role text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT p.id, p.name, p.slug, p.timezone, m.role
    FROM memberships m
    JOIN practices p ON p.id = m.practice_id
    WHERE m.user_id = p_user_id
      AND m.status = 'active'
      AND p.status = 'active'
    ORDER BY p.name, p.id
  $$;

-- ------------------------------------------------------------------ grants

REVOKE ALL ON FUNCTION
  auth_find_user_by_email(citext),
  auth_record_login_failure(uuid),
  auth_record_login_success(uuid),
  auth_list_user_practices(uuid)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  auth_find_user_by_email(citext),
  auth_record_login_failure(uuid),
  auth_record_login_success(uuid),
  auth_list_user_practices(uuid)
TO frontdesk_app;
