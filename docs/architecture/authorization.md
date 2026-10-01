# Authorization, tenancy and member management

Status: implemented (milestone 1, step 5). Code: `apps/api/src/tenancy`, `members`, `practices`, `audit`. Permissions live in `packages/shared/src/permissions.ts`. Authentication (who you are) is in [authentication.md](authentication.md).

## Permissions

| Permission | owner | admin | staff | viewer |
|---|:-:|:-:|:-:|:-:|
| `practice:read` | yes | yes | yes | yes |
| `practice:manage` (name, time zone, phone) | yes | yes | | |
| `members:read` | yes | yes | yes | |
| `members:manage` | yes | yes | | |
| `audit:read` | yes | yes | | |
| `knowledge:read` (see the clinic information the AI uses) | yes | yes | yes | |
| `knowledge:manage` (write, approve, archive it) | yes | yes | | |
| `tasks:read` (see the callback and message queue) | yes | yes | yes | |
| `tasks:manage` (create, assign, complete tasks) | yes | yes | yes | |

| `ai:read` (see how the AI receptionist is set up) | yes | yes | yes | |
| `ai:configure` (change it, turn it on or off) | yes | yes | | |
| `calls:read` (read conversations with the AI receptionist) | yes | yes | yes | |

Staff hold `tasks:manage` on purpose: they answer the phones and work the callback queue. It is the only write permission staff have.

The API enforces this. The web app imports the same table only to hide controls that would be refused anyway. Adding a role without deciding its permissions is a compile error.

## Three global guards, in order

1. **Rate limit** (per IP).
2. **`AccessTokenGuard`**: a valid, unexpired access token, or the route is `@Public()`.
3. **`PermissionsGuard`**, for every route that is not public:
   - **No access rule, no entry.** A route must declare `@RequirePermissions(...)`, `@Authenticated()` (any active member) or `@Public()`. A route with none is refused with 403 and an error is logged, so a forgotten decorator fails closed.
   - **Live check.** One database query confirms the person still has access *right now*: the session behind the token has not been logged out or expired, the membership is active, and the user and practice are active. It also reads their **current** role. So logout, suspension, removal and demotion take effect on the next request, not when the 10-minute token expires.
   - **Permission check** against that current role. The verified role replaces the one in the token for everything downstream.

A user who is *promoted* keeps their old token's lower role only until they sign in again or refresh; the guard uses the database role, so they are never held back by a stale token and never trusted beyond their real role.

## Tenancy

- The practice a request acts in comes **only** from the verified token. There is no route parameter, query, header or body field that selects a practice, and DTOs reject unknown fields, so `{"practiceId": ...}` is a 400.
- All tenant data access goes through `TenantDb.run(auth, ...)`, which runs the work in a transaction with the practice set for row-level security. PostgreSQL then hides every other practice's rows, even if application code had a bug.
- Another practice's record is answered as **404**, not 403, so responses never confirm that it exists.

## Member management rules

`PATCH /api/members/:userId` (`members:manage`), decided by the pure function `authorizeMemberChange`:

- Nobody changes their own role or status.
- An **owner** may change any other member.
- An **admin** may only manage staff and viewers, and may only make someone staff or viewer. Changing admins and owners, or creating them, is owner-only, so admins cannot escalate themselves or each other.
- Changing a role or suspending a member **ends that member's sessions**.
- A request that changes nothing is a 400.
- **A practice always keeps at least one active owner.** The API cannot reach that state, and a database trigger guarantees it anyway. It locks the remaining owners while checking, so two owners demoting each other at the same moment are serialised (one succeeds, the other is refused). Concurrent requests that collide in the database get `409 Please try again` rather than a server error.

## Database privileges added

The API's database role can update only `practices(name, timezone, phone)` and `memberships(role, status)`. It cannot change a practice's short name, status or id, nor who a member is or which practice they belong to, and cannot create memberships or users. (Migration `0004`.)

## Endpoints

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /api/practice` | `practice:read` | The caller's own practice |
| `PATCH /api/practice` | `practice:manage` | Partial update; `phone: null` clears; audited (`practice.updated`, field names only) |
| `GET /api/members` | `members:read` | Members of the caller's practice (capped at 500) |
| `PATCH /api/members/:userId` | `members:manage` | Role and/or status; audited (`member.role_changed`, `member.suspended`, `member.reactivated`) |
| `GET /api/audit-logs?limit&cursor` | `audit:read` | Newest first; default 50, max 200; stable cursor paging |
| `GET /api/knowledge`, `GET /api/knowledge/:id`, `GET /api/knowledge/search?q=` | `knowledge:read` | The AI receptionist's knowledge base (see [ai-receptionist.md](ai-receptionist.md)); search shows what the AI would find |
| `GET /api/tasks?status&assignee&limit&cursor`, `GET /api/tasks/:id` | `tasks:read` | The task queue: default is open and in-progress, newest first; filter by status and by assignee (`me`, `unassigned`, or a person); cursor paging |
| `GET /api/ai/settings`, `GET /api/ai/transfer-targets` | `ai:read` | The AI receptionist's configuration, with `ready` and `problems` (what still blocks turning it on) |
| `PATCH /api/ai/settings`, `POST /api/ai/transfer-targets`, `PATCH /api/ai/transfer-targets/:id` | `ai:configure` | Partial updates. The AI cannot be turned on until a greeting, an emergency message, a crisis message (suicide and self-harm), business hours and any needed active transfer number are set (409 lists what is missing); a number the settings use cannot be deactivated; audited by field names only |
| `POST /api/tasks`, `PATCH /api/tasks/:id` | `tasks:manage` | Create and edit tasks, assign to an active member of the practice, change status (a finished task can only be reopened, and must be reopened before it is edited); never deleted, only cancelled; audited without the contact details |
| `POST /api/knowledge`, `PATCH /api/knowledge/:id`, `POST /api/knowledge/:id/{approve,archive,restore}` | `knowledge:manage` | New entries are drafts; only an approved entry can be used, and editing approved wording withdraws the approval; audited |
| `POST /api/agent/test-conversations`, `POST /api/agent/test-conversations/:id/messages` | `ai:configure` | A text test chat with the practice's own receptionist (see [ai-receptionist.md](ai-receptionist.md)); 409 until a greeting and an emergency message exist, 503 until a language model is configured; 30 requests a minute per IP |
| `GET /api/conversations?limit&cursor`, `GET /api/conversations/:id` | `calls:read` | Conversation list (newest first, cursor paging) and full transcript with every tool call; viewing a transcript is audited (`conversation.viewed`) |
| `GET /api/ai/phone-numbers` | `ai:read` | The phone numbers connected to the practice (read-only; the operator connects them with `npm run phone`). See [telephony-voice.md](telephony-voice.md) |
| `POST /api/voice/incoming`, `POST /api/voice/action` (more in the next steps) | none: public, but every request must carry a valid Twilio signature (403 otherwise; 404 while voice is off) | Incoming calls from Twilio; answers with TwiML (XML). Not reachable with a user login and never acts for a signed-in user. The practice comes only from the dialed number |
| `GET /api/auth/me`, `POST /api/auth/switch-practice` | any active member | |

## Known limits and deferred work

- **Adding people:** there is no endpoint to invite or create members yet (it needs email delivery). Members are added by the schema owner (for example with `npm run bootstrap` for the first owner).
- **Per-request database check:** one small query per request. Fine at this scale; cache with a very short TTL only if it ever shows up in profiling, and remember that would reintroduce a delay.
- **Practice-level restriction** (staff limited to particular locations) is not modelled: a practice is the tenant.
- **Production database owner role:** as noted in the authentication doc, it must be able to bypass row-level security (or explicit owner policies must be added) for migrations and bootstrap.
