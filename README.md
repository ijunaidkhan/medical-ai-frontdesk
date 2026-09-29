# AI Medical Front Desk

Multi-tenant SaaS AI medical receptionist. See [CLAUDE.md](CLAUDE.md) for product and architecture rules.

## Layout

| Path | What it is |
|---|---|
| `apps/web` | Angular web app |
| `apps/api` | NestJS API |
| `packages/shared` | TypeScript types and constants shared by web and API (`@frontdesk/shared`) |

## Getting started

Requires Node 24, npm 11 and Docker Desktop.

```bash
npm install
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
                          # then set the two DB passwords and put them in the two URLs
npm run db:up             # start PostgreSQL in Docker
npm run db:migrate        # create/upgrade the schema
npm run api:dev           # API on http://localhost:3000 (builds shared first)
npm run web:start         # web on http://localhost:4200
```

Check the API: `GET http://localhost:3000/health/live` (process up) and `GET http://localhost:3000/health/ready` (database reachable).

## Database

- PostgreSQL 18 in Docker, reachable only from this machine (`127.0.0.1:5432`). Data survives restarts in a Docker volume.
- **Each practice is a tenant.** Every tenant-owned table has `practice_id` and PostgreSQL row-level security, so a query can only see the practice set for its transaction (`withPracticeContext` in `apps/api/src/database/practice-context.ts`). With no practice set, queries return nothing.
- Two roles: `frontdesk_owner` runs migrations; the API connects as `frontdesk_app`, which cannot bypass row-level security or change the schema.
- Migrations are plain SQL in `apps/api/migrations` (`NNNN_name.up.sql` + `.down.sql`).

| Command | Does |
|---|---|
| `npm run db:up` / `npm run db:down` | Start / stop PostgreSQL (data is kept) |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:migrate:down` | Revert the latest migration |
| `npm run db:migrate:status` | List applied and pending migrations |

## Common commands

| Command | Does |
|---|---|
| `npm run typecheck` | Strict type check of every workspace |
| `npm test` | Unit and end-to-end tests of every workspace |
| `npm run api:test` | API unit and end-to-end tests (no database needed) |
| `npm run api:test:integration` | API tests against a real, freshly migrated `frontdesk_test` database, including tenant isolation (needs `db:up`) |
| `npm run web:test` | Web unit tests |
| `npm run api:build` / `npm run web:build` | Production builds |

## Configuration

All settings come from environment variables, documented in [.env.example](.env.example). The API validates them at startup and refuses to start if any are invalid. Real secrets never go in `.env.example` or in git.
