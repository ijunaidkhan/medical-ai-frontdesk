# Web app

Status: implemented (milestone 1, step 6). Code: `apps/web/src/app`. Angular 22, standalone components, signals, no zone.js, no UI library.

## Layout

```
core/auth      AuthService (session in memory), interceptor, route guards, safe return URL
core/api       PracticeApi (typed calls), error messages, LoadState helper
features/      login, shell (header + nav), dashboard, team, activity
testing/       test helpers only (excluded from the app build)
```

Pages are lazy-loaded; the first download is about 73 kB compressed.

## How sign-in works in the browser

- **The access token lives in memory only.** It is never written to localStorage, sessionStorage or a cookie, so a script injected into the page cannot read it back later. A test asserts this.
- **The refresh token is an httpOnly cookie** the browser manages; the app never sees it.
- **Reload:** memory is empty after a reload, so an app initializer calls `POST /api/auth/refresh` before the first page is chosen. If the cookie is still good the person stays signed in; if not they land on the login page. This does one request and no retry, so a signed-out visit is not slowed down.
- **Expired token:** the interceptor adds `Authorization: Bearer ...` to calls to `/api/...` only (never to other addresses, never to the login/refresh/logout calls). On a 401 it renews the session once, then repeats the call once. Calls that fail together share one renewal (each use of the cookie rotates it, so two at once would clash). A call is never repeated twice, so a genuine 401 cannot loop.
- **Two browser tabs renewing at the same moment:** the API refuses the loser for a few seconds while the winner's response replaces the shared cookie; the app waits 400 ms and tries once more.
- **No background timer refreshes the session.** Renewal happens only when the person is actually doing something, so the API's 30-minute idle timeout works as designed.
- **Session ends** (renewal refused): the app returns to the login page and comes back to the same page after sign-in. **Deliberate sign-out** ends the session on the server first, then goes to the login page with no return address. If the server cannot be reached, signing out still forgets the session locally.
- **A transient server or network error during renewal does not sign anyone out**; only an explicit refusal does.
- **Return addresses** (`?returnUrl=`) come from the URL, so only in-app paths are accepted; anything that could lead to another site (`//host`, `https://...`, backslashes, control characters, the login page itself) falls back to the dashboard.

## One address for the browser

The browser calls the API at the same address it loaded the app from (`/api/...`). In development the Angular dev server proxies `/api` to the API on port 3000 (`apps/web/proxy.conf.json`); there is no CORS and the refresh cookie (`SameSite=Strict`, path `/api/auth`) just works. **In production the web app and `/api` must be served from the same host** (for example, a load balancer routing `/api/*` to the API), and `CORS_ORIGINS` must list that origin, because the API's CSRF check on refresh and logout requires an allowed `Origin`.

That production shape is provided and tested: `docker compose --profile full up` runs the web app behind nginx (`infra/docker/nginx`), which serves the built files, forwards `/api/` to the API container, overwrites `X-Forwarded-For` with the real client address (the API is set to trust exactly one proxy), and adds security headers. The same 23-step login, refresh, cross-site refusal, practice-switch and logout run was passed through it.

**Content-Security-Policy.** nginx sends `script-src 'self'` (only the app's own files may run scripts) and `style-src 'self' 'unsafe-inline'` (Angular adds component styles at run time). To make that policy possible, the production build turns off Angular's critical-CSS inlining, which would otherwise add an inline `<script>` to `index.html` that the policy blocks and leave the page unstyled.

## Permissions in the interface

The menu, page guards and dashboard sections use `hasPermission` from `@frontdesk/shared` so people are not shown things that would be refused. That is a convenience only: the API checks the database on every request and refuses anything not allowed, whatever the browser does. The dashboard does not even request the team or activity data for a role that may not see it.

## Pages

| Page | Who | Data (all from the API, none invented) |
|---|---|---|
| `/login` | signed-out | `POST /api/auth/login` |
| `/dashboard` | everyone | practice details, your role and what it allows; team counts (`members:read`); latest activity (`audit:read`) |
| `/team` | `members:read` | member list (read-only) |
| `/ai` | `ai:read` to see, `ai:configure` to change (owner, admin) | the AI receptionist's settings and transfer numbers: greeting (with the always-added AI notice), medical-emergency message, crisis message, business hours (24-hour text boxes, because a browser time box cannot show 24:00), after-hours and urgent handling, extra urgent phrases, on/off with the list of what still blocks turning it on. Changes are saved together and only what changed is sent; turning it on or off is a separate button and is disabled while there are unsaved changes |
| `/activity` | `audit:read` | audit log, 25 at a time, "Load more" |

Switching practice (menu shown when the person belongs to more than one) starts a new session in that practice and returns to the dashboard; every page reloads its data whenever the practice changes, and a slow answer for the practice just left is ignored.

Times are shown in the practice's own time zone.

## Testing

193 unit and component tests (Vitest, jsdom, real interceptor and services against a fake HTTP backend), plus mutation checks on the security behaviours (token storage, interceptor scope and retry limits, return-URL check, guards, per-role menu and requests). The whole stack was also exercised over real HTTP through the dev server's proxy (login, refresh, CSRF origin refusal, switch practice, logout).

## Known limits

- **Not yet checked in a real browser or with an accessibility tool.** Semantics (labels, `aria-invalid`, `role="alert"`, landmarks, skip link, focus styles) are tested in jsdom, but nobody has looked at it on screen yet.
- Editing the practice or managing team members is available in the API but has no screens yet. Screens for knowledge, staff tasks, conversation review and the test chat are the next steps of the AI receptionist plan ([ai-receptionist.md](ai-receptionist.md)).
- No password reset, invitations or multi-factor sign-in (see authentication.md).
- No end-to-end browser tests (for example Playwright) yet.
