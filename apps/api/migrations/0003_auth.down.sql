DROP FUNCTION auth_list_user_practices(uuid);
DROP FUNCTION auth_record_login_success(uuid);
DROP FUNCTION auth_record_login_failure(uuid);
DROP FUNCTION auth_find_user_by_email(citext);
ALTER TABLE refresh_tokens DROP CONSTRAINT refresh_tokens_expiry_within_session;
ALTER TABLE refresh_tokens DROP COLUMN session_expires_at;
