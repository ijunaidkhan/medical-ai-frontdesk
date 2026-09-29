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

Open http://localhost:4200 and sign in with the account you created with `npm run bootstrap`. Start the API first: the web app talks to it through the dev server's proxy. Details: [web app](docs/architecture/web-app.md).

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
