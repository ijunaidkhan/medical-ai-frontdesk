# Authentication and sessions

Status: implemented (milestone 1, step 4). Code: `apps/api/src/auth`. Database: `apps/api/migrations`.

## Model

- **A practice is the tenant.** A *user* is a global identity (one email); a *membership* gives that user a role in one practice. One person can belong to several practices and switch between them.
- **Roles per practice:** `owner`, `admin`, `staff`, `viewer` (`packages/shared/src/roles.ts`). Enforcement of what each role may do (RBAC) is the next step; authentication only establishes *who* and *which practice*.
- The tenant of every request comes **only from the verified access token**, never from a URL, header, or body the client controls.

## Tokens

| | Access token | Refresh token |
|---|---|---|
| Purpose | Authorises API calls | Gets a new access token |
| Format | JWT, HS256, pinned algorithm | `<practiceId>.<256 random bits>` |
| Lifetime | 10 minutes | 30 minutes idle, 12 hours absolute |
| Where it lives | Browser **memory** only, sent as `Authorization: Bearer` | `HttpOnly`, `SameSite=Strict`, `Secure` (production) cookie, path `/api/auth` |
| Stored server-side | No | Only a SHA-256 hash (`refresh_tokens`) |
| Claims | `sub` user, `pid` practice, `role`, `sid` session | — |

The signing key is `ACCESS_TOKEN_SECRET` (at least 32 random characters, checked at startup).

## Flows

**Login** `POST /api/auth/login` (public, 20/min per IP)
1. Look up the user by email through a narrow `SECURITY DEFINER` database function (row-level security hides users before a practice is known).
2. Verify the password with **Argon2id** (Node's built-in implementation, OWASP parameters, PHC-format hashes). For an unknown email a real hash of a random secret is verified instead, so timing does not reveal which accounts exist.
3. Every failure (unknown email, wrong password, locked, disabled, no active practice, practice not permitted) returns the same `401 Invalid email or password`.
4. Failures are counted; **5 in a row lock the account for 1 minute, doubling per further failure up to 1 hour.** A locked account refuses even the correct password.
5. On success: pick the requested practice (or the first by name), create a session, return `{ accessToken, user, practice, practices }` and set the refresh cookie.

**Refresh** `POST /api/auth/refresh` (cookie + allowed `Origin`, 60/min per IP)
- Rotation: every use returns a new refresh token and revokes the old one. The session's absolute end time is carried along, so refreshing never extends a login past 12 hours.
- **Theft detection:** presenting an already-rotated token more than 20 seconds after it was rotated revokes the *entire session* and is audited (`auth.refresh.reuse_detected`). Within 20 seconds it is treated as two browser tabs racing: the request is refused but the session and cookie are left alone.
- The role, membership, user and practice status are re-read from the database on every refresh, so suspensions and role changes take effect within one access-token lifetime. If access was removed the session is revoked (`auth.refresh.denied`).

**Logout** `POST /api/auth/logout` — revokes the whole session; idempotent.

**Switch practice** `POST /api/auth/switch-practice` (access token) — starts a new session in another practice the user actively belongs to and ends the current one. The absolute session end carries over. Refused (`403`, same answer whether the practice exists or not) if the user is not an active member.

**Identity** `GET /api/auth/me` — current user, practice and role, read from the database.

## Deny by default

`AccessTokenGuard` is global: every route needs a valid access token unless it is marked `@Public()`. A route someone forgets to protect is closed, not open (`test/deny-by-default.e2e-spec.ts` proves this with a route that has no protection of its own). Use `@CurrentAuth()` to read the verified identity; never take the tenant from request input.

## Tenant isolation in the database

Requests that touch tenant data run through `withPracticeContext`, which sets the practice for the transaction; PostgreSQL row-level security then makes every other practice's rows invisible. The API connects as `frontdesk_app`, which cannot bypass those policies or change the schema. Login functions are the only `SECURITY DEFINER` code; each does one thing, pins `search_path`, and is granted only to `frontdesk_app`.

## Rate limiting and client IP

Per-IP limits: 300/min default, 20/min login, 60/min refresh (health probes exempt). The client IP is the socket address unless `TRUST_PROXY_HOPS` is set; then it is taken from `X-Forwarded-For` counting that many trusted proxies from the right. Set it to the real number of load balancers: too low and everyone shares one address, too high and clients can fake theirs.

## Audit events

`auth.login.success`, `auth.login.failed` (reason code + email *fingerprint*, never the email or password), `auth.account.locked`, `auth.refresh.reuse_detected`, `auth.refresh.denied`, `auth.logout`, `auth.practice.switched`, `bootstrap.practice_created`. The table is append-only (privileges and triggers).

## First account

`npm run bootstrap` creates the first practice and owner (hidden password prompt, minimum 15 characters, no composition rules, per NIST SP 800-63B-4). It uses the schema-owner connection because the API's own role cannot create practices or users by design.

## Known limits and deferred work

- **Access tokens are stateless.** After logout, suspension or a role change, an already-issued access token keeps working for up to 10 minutes (refresh, `/me` and switch-practice do check the database). If a route later needs immediate revocation, add a per-request session check for it.
- **No multi-factor authentication yet.** Required before real patient data; the 15-character minimum is the NIST allowance for single-factor passwords.
- **Not built:** password reset and user invitations (need email delivery), user/role management endpoints, list/revoke own sessions, breached-password screening.
- **Rate-limit counters are in process memory.** With more than one API instance, move them to a shared store (e.g. Redis).
- **Deployment:** TLS to the database, secrets from a secrets manager, and the production database owner role (it must be able to bypass row-level security, or explicit owner policies must be added, for migrations and bootstrap) are decisions for the deployment milestone.
