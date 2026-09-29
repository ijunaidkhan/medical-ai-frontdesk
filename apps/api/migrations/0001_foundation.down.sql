-- The users policy reads memberships, so it must go before that table does.
DROP POLICY users_visible_in_context ON users;
DROP TABLE memberships;
DROP TABLE users;
DROP TABLE practices;
DROP FUNCTION set_updated_at();
DROP FUNCTION app_current_user_id();
DROP FUNCTION app_current_practice_id();
