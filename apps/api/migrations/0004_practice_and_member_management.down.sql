DROP TRIGGER memberships_keep_an_owner ON memberships;
DROP FUNCTION memberships_keep_an_owner();
REVOKE UPDATE (role, status) ON memberships FROM frontdesk_app;
REVOKE UPDATE (name, timezone, phone) ON practices FROM frontdesk_app;
