# AI Medical Front Desk

Multi-tenant SaaS AI medical receptionist. See [CLAUDE.md](CLAUDE.md) for product and architecture rules.

## Layout

| Path | What it is |
|---|---|
| `apps/web` | Angular web app |
| `apps/api` | NestJS API |
| `packages/shared` | TypeScript types and constants shared by web and API (`@frontdesk/shared`) |
| `docs/architecture` | Design notes: [authentication](docs/architecture/authentication.md), [authorization](docs/architecture/authorization.md), [web app](docs/architecture/web-app.md) |

## Getting started

Requires Node 24, npm 11 and Docker Desktop.

```bash
npm install
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
                          # then fill in the blanks (see the comments in the file):
                          # two database passwords, the two connection URLs, ACCESS_TOKEN_SECRET
npm run db:up             # start PostgreSQL in Docker
npm run db:migrate        # create/upgrade the schema
npm run bootstrap         # create the first practice and its owner (asks for a password)
npm run api:dev           # API on http://localhost:3000 (builds shared first)
npm run web:start         # web on http://localhost:4200 (forwards /api to the API)
```

Open http://localhost:4200 and sign in with the account you created with `npm run bootstrap`. Start the API first: the web app talks to it through the dev server's proxy. Details: [web app](docs/architecture/web-app.md). Product notes: [competitors and positioning](docs/product/competitors.md).

### Or run everything in Docker

Instead of the two dev servers, the whole stack can run in containers (database, API, and the web app behind nginx):

```bash
docker compose --profile full up -d --build   # first build takes a few minutes
docker compose --profile tools run --rm migrate   # apply migrations (once, and after upgrades)
```

Then open http://localhost:8080. Only the web port is published; the API is reachable only through nginx, which serves the app, forwards `/api`, and sends strict security headers (including a Content-Security-Policy that allows only the app's own scripts). Stop it with `docker compose --profile full down`. This mode is for trying the deployment shape locally; day-to-day development uses `npm run api:dev` and `npm run web:start`.

Because Docker Compose builds the database URL from your passwords, avoid `@`, `:` and `/` in `DB_APP_PASSWORD` and `DB_OWNER_PASSWORD`.

The API is served under `/api`. Check it: `GET /api/health/live` (process up) and `GET /api/health/ready` (database reachable).

## API

| Endpoint | Access | Does |
|---|---|---|
| `POST /api/auth/login` | public, 20/min per IP | Email + password; returns the session and sets the refresh cookie |
| `POST /api/auth/refresh` | refresh cookie + allowed Origin | New access token, rotated refresh cookie |
| `POST /api/auth/logout` | refresh cookie + allowed Origin | Ends the session |
| `GET /api/auth/me` | any active member | Current user, practice and role |
| `POST /api/auth/switch-practice` | any active member | Move to another practice the user belongs to |
| `GET /api/practice` | `practice:read` (everyone) | The caller's own practice |
| `PATCH /api/practice` | `practice:manage` (owner, admin) | Change name, time zone, phone |
| `GET /api/members` | `members:read` (owner, admin, staff) | Members of the caller's practice |
| `PATCH /api/members/:userId` | `members:manage` (owner, admin) | Change a member's role or status (admins are limited to staff and viewers) |
| `GET /api/audit-logs` | `audit:read` (owner, admin) | The practice's audit trail, newest first, paged |
| `GET /api/knowledge`, `/api/knowledge/:id`, `/api/knowledge/search?q=` | `knowledge:read` (owner, admin, staff) | The clinic information the AI receptionist may use; search shows what it would find |
| `GET /api/ai/settings`, `/api/ai/transfer-targets` | `ai:read` (owner, admin, staff) | How the AI receptionist is set up, and what still blocks turning it on |
| `PATCH /api/ai/settings`, `POST`/`PATCH /api/ai/transfer-targets` | `ai:configure` (owner, admin) | Greeting, business hours, after-hours and urgent-call handling, emergency message (911) and crisis message (988), transfer numbers, on/off (the AI cannot be turned on until it is safely set up) |
| `GET /api/tasks`, `/api/tasks/:id` | `tasks:read` (owner, admin, staff) | The queue of callback and message requests (created by staff, and later by the AI receptionist) |
| `POST /api/tasks`, `PATCH /api/tasks/:id` | `tasks:manage` (owner, admin, staff) | Create, assign, edit and complete tasks (never deleted, only cancelled) |
| `GET /api/scheduling/settings`, `/api/providers`, `/api/appointment-types`, `/api/availability` | `schedule:read` (owner, admin, staff) | Booking rules, providers and their hours, visit types, and the open times a caller would be offered |
| `GET /api/appointments`, `/api/appointments/:id` | `schedule:read` (owner, admin, staff) | The calendar |
| `GET /api/patients`, `/api/patients/:id` | `patients:read` (owner, admin, staff) | Find patients by name or phone (audited) |
| `POST /api/patients`, `POST /api/appointments`, `.../:id/cancel`, `.../:id/reschedule` | `schedule:manage` (owner, admin, staff) | Add patients; book, cancel and move appointments (the database refuses double booking; a repeated request books once) |
| `PATCH /api/scheduling/settings`, `POST`/`PATCH /api/providers`, `/api/appointment-types`, provider time off | `schedule:configure` (owner, admin) | Set up scheduling (nothing is deleted; the AI cannot be allowed to book until a provider with hours offers a visit type) |
| `POST /api/agent/test-conversations`, `.../:id/messages` | `ai:configure` (owner, admin) | Text test chat with the practice's AI receptionist (needs a configured language model: 503 until then) |
| `GET /api/conversations`, `/api/conversations/:id` | `calls:read` (owner, admin, staff) | Review conversations and what the AI did; viewing a transcript is audited |
| `POST`/`PATCH /api/knowledge`, `POST /api/knowledge/:id/approve`, `/archive`, `/restore` | `knowledge:manage` (owner, admin) | Write, approve and retire that information (only approved text is ever used) |
| `GET /api/health/live`, `/ready` | public | Liveness / readiness |

Every route needs an access token and an explicit access rule, or it is refused; the practice a request acts in always comes from the verified token. Details, limits and deferred work: [authentication](docs/architecture/authentication.md) and [authorization](docs/architecture/authorization.md).

## Database

- PostgreSQL 18 in Docker, reachable only from this machine (`127.0.0.1:5432`). Data survives restarts in a Docker volume.
- **Each practice is a tenant.** Every tenant-owned table has `practice_id` and PostgreSQL row-level security, so a query can only see the practice set for its transaction (`withPracticeContext` in `apps/api/src/database/practice-context.ts`). With no practice set, queries return nothing.
- Two roles: `frontdesk_owner` runs migrations and bootstrap; the API connects as `frontdesk_app`, which cannot bypass row-level security or change the schema.
- Migrations are plain SQL in `apps/api/migrations` (`NNNN_name.up.sql` + `.down.sql`).

| Command | Does |
|---|---|
| `npm run db:up` / `npm run db:down` | Start / stop PostgreSQL (data is kept) |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:migrate:down` | Revert the latest migration |
| `npm run db:migrate:status` | List applied and pending migrations |
| `npm run bootstrap` | Create the first practice and owner account |
| `npm run phone -- add --practice alpha --number +14155550123` | Connect a phone number to a practice (also `list`, `enable`, `disable`); operator only |

## Common commands

| Command | Does |
|---|---|
| `npm run typecheck` | Strict type check of every workspace |
| `npm test` | Unit and end-to-end tests of every workspace (no database needed) |
| `npm run api:test:integration` | API tests against real, freshly migrated throwaway databases: tenant isolation, login, sessions, rate limits (needs `db:up`) |
| `npm run web:test` | Web unit tests |
| `npm run api:build` / `npm run web:build` | Production builds |

## Configuration

All settings come from environment variables, documented in [.env.example](.env.example). The API validates them at startup and refuses to start if any are invalid (messages name the variable but never print its value). Real secrets never go in `.env.example` or in git.
