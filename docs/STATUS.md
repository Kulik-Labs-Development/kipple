# STATUS

Rolling build state for Kipple. **Every work session must read this first and
update it (plan table + recent sessions) before committing**, so any other
chat or contributor can pick up where work left off. Deep design lives in
`docs/PLAN.md`; conventions in `AGENTS.md`.

## Current phase

**Phase 1 — Core ticketing.** Phase 0 (foundation) is complete.
Next up: email inbound (plan item 6) — worker IMAP IDLE + mailparser,
Message-ID dedupe, thread matching (References → alias → subject tag →
contact), no match → new ticket.

## What's live

- Monorepo (pnpm + Turborepo); CI (lint/typecheck/test) + GHCR image builds on push
  (`ghcr.io/kulik-labs-development/kipple/{api,worker,mcp}`, public → anonymous pull);
  `infra/docker-compose.yml` deploys via CLI or as a Portainer CE/BE stack
  (needs `AUTH_SECRET` + `PUBLIC_URL`; optional `KIPPLE_TAG`, `TRUST_PROXY`,
  `COMPOSE_PROFILES=proxy|dev`) — full guide in `docs/DEPLOYMENT.md`
- Postgres schema (Drizzle, migrations auto-run on api boot): users, sessions,
  accounts, verification, twoFactor, clients, contacts, contact_clients, tickets,
  updates, settings, email_outbox
- better-auth: email+password, TOTP 2FA plugin (UI not built yet), signups closed
  after first user; first-run setup wizard makes owner a superuser
- RBAC: `role` column + `requireUser`/`requireRole` helpers
- Theme system: token-swap themes (console, graphite, slate, blush) in
  `packages/ui/themes/`, registry in `@kipple/shared` (`THEMES`), instance theme in
  `settings` key `theme`, per-user theme/color-mode via `PATCH /api/preferences`
- Ticket domain API: `GET/POST /api/clients`, `GET/PATCH/DELETE /api/clients/:id`,
  contact CRUD + M2M client links (one primary), `GET/POST /api/tickets`
  (filters: status/priority/clientId/assignedTo/q), `GET/PATCH/DELETE /api/tickets/:id`
  (delete = soft, status `deleted`), `POST /api/tickets/:id/updates`
  (public/internal; contacts forced public)
- Ticket numbers: Postgres sequence `ticket_number`; alias
  `support+{number}@{domain}` assigned on create (domain from `settings` key
  `email`, fallback `kipple.local`)
- Client scoping in the query layer: contact users only see their contact's
  clients (404 for out-of-scope ids, never 403 — no existence leaks); enforced
  by `clientScope()` in `apps/api/src/access.ts`
- Audit log: `audit` table + `logAudit()` on every domain mutation
- `users.contact_id` links portal users to contact records; `/api/me` returns
  `contactId`
- Web: setup, login, workspace shell (Tailwind v4, semantic tokens only)
- Ticket domain API: clients, contacts (M2M `contact_clients` with one
  primary), tickets (sequential number + `support+{n}@{domain}` alias on
  create), updates (public/internal), `GET /api/users` (staff list). Audit
  log on every domain mutation. Client scoping enforced in the query layer:
  contact users only see their own clients' data; internal notes and deleted
  tickets are never returned to contacts
- Agent workspace UI: queue pane (status filters with counts, subject search
  with `/` shortcut, status LED, priority badges, relative timestamps),
  ticket detail (status/priority/assignee/tags controls, terminal-style
  update timeline, public reply / internal note composer, soft delete),
  new-ticket modal, live stats tiles, 30s polling
- Ticket alias scheme locked: plus-addressed `support+{number}@{domain}`, no
  subdomains/catch-alls (PLAN.md §5, §12 #10)
- Email outbound (§5b): pluggable provider interface (`send`/`testConnection`/
  `status`) in `packages/mail` with a generic SMTP provider (nodemailer;
  no-auth/basic-auth, STARTTLS/TLS); delivery pipeline = `email_outbox` row
  (audit log) + BullMQ `email-outbox` queue → worker delivery with retry +
  exponential backoff (5 attempts, 30s→1h cap), permanent errors (535/550/553/
  554, auth failures) fail fast; staff public updates + staff ticket creates
  with a body enqueue a client reply (From = configured sender, Reply-To =
  ticket alias, subject tagged `[KIP-{n}]`); SMTP password encrypted at rest
  (AES-256-GCM keyed from AUTH_SECRET, `enc1:` prefix); API: `GET/POST
  /api/email` (settings, masked), `POST /api/email/test-connection`,
  `GET /api/outbox` (filterable activity log), `GET /api/outbox/provider`
  (status), `POST /api/outbox/test` (one-click test send),
  `POST /api/outbox/:id/retry`. M365/Google providers = Phase 2

## Phase 1 — active plan

| # | Item | Status |
|---|------|--------|
| 1 | Ticket domain API: clients, contacts (M2M with primary client), tickets (number + alias), updates (public/internal) | done |
| 2 | Client scoping in query layer + mandatory client-scoping tests (contact users only ever see their own client's data) | done |
| 3 | Audit log on all mutations | done |
| 4 | `users.contact_id` link so portal users map to contact records | done |
| 5 | Email outbound: provider queue (§5b) — generic SMTP first, then M365 OAuth2 (adoption gate) | done (SMTP; M365/Google = Phase 2) |
| 6 | Email inbound: worker IMAP IDLE (imapflow) + mailparser, Message-ID dedupe, thread matching (References → alias → subject tag → contact), no match → new ticket | not started — NEXT |
| 7 | Agent workspace UI: queue, ticket detail with update timeline, reply, status/priority/assign/tags | done (SLA timers arrive with item 10) |
| 8 | Client portal + magic-link login for contacts (portal users hard-scoped to their clients) | not started |
| 9 | Time tracking v1 (billable/non-billable per ticket/agent/client) | not started |
| 10 | SLA feature (enable-able, OFF by default; per-client/per-ticket policy precedence) | not started |
| 11 | Email templates + rules v1 (nothing auto-sends by default), notification center, dashboard stats + presence | not started |
| 12 | Per-client branding override for portal theme (uses `clients.branding`) | not started |

## Recent sessions

- **2026-08-31 (Portainer deploy session)** — Made `infra/docker-compose.yml`
  deployable as a Portainer CE stack. Key change: dropped the `./Caddyfile`
  bind mount (relative-path volumes are a Portainer Business Edition feature,
  so CE uploads of the proxy profile would fail) — the Caddyfile is now
  inlined in the caddy service's `CADDYFILE` env var, written at container
  start; `infra/Caddyfile` stays as the documented copy-paste config for
  BYO-proxy hosts (keep the two in sync). Verified against Portainer
  docs/issues which compose features its stack deployer supports:
  `depends_on: condition: service_healthy` works (portainer/portainer#11757),
  profiles activate via the `COMPOSE_PROFILES` stack env var (one value or `*`;
  comma lists are a known bug, #13033), and `healthcheck.start_interval` must
  be avoided. Added compose-level healthchecks to api (`/healthz`) and worker
  (node-process liveness — placeholder until the email pipeline adds a real
  endpoint) so every service has one. Wrote `docs/DEPLOYMENT.md` (env var
  reference, CLI + Portainer CE/BE deploys, Mode A/B proxy recipes, backups,
  MCP-as-stdio note) and a `COMPOSE_PROFILES` section in `.env.example`.
  Another session's in-flight `packages/mail` + `packages/shared` crypto files
  were left untouched and uncommitted.
- **2026-08-31 (email outbound)** — Built the §5b outbound pipeline.
  `@kipple/mail`: provider interface (`send`/`testConnection`/`status`),
  generic SMTP provider (nodemailer), `deliverOutbox()` status machine
  (queued→sent/failed, 5 attempts, exponential backoff 30s→1h, permanent
  errors fail fast) — 21 unit tests incl. live round-trips against a local
  `smtp-server`. `@kipple/shared`: `EmailSettings`/`StoredEmailSettings`
  schemas, outbox job/status schemas, queue name, AES-256-GCM at-rest
  encryption (key derived from AUTH_SECRET, `enc1:` prefix). API: extended
  `email_outbox` (from/from_name/body/reply_to/message_id/attempts/
  next_try_at, migration 0003), `src/mail.ts` (enqueue is DB-first — the row
  is the audit log; BullMQ is the trigger, so a Redis blip loses no mail),
  `routes/email.ts` (`/api/email` GET/POST + test-connection, `/api/outbox`
  list/provider/test/retry), staff public updates + staff ticket-creates with
  a body enqueue the client reply (Reply-To = ticket alias, `[KIP-{n}]`
  subject tag, recipient = primary contact then any contact with an email;
  no email settings or no contact email = silent no-op — nothing auto-sends).
  Worker: `email-outbox` BullMQ worker reuses the API's `processOutboxJob`
  wiring (workspace dep on `@kipple/api`, imports `@kipple/api/src/mail`);
  keeps the `email-ingest` placeholder. CI: added Redis service (BullMQ).
  API e2e: 10 new outbox tests (encrypt at rest, masking, enqueue, no-op
  cases, SMTP delivery with header assertions, idempotency, retry). Verified:
  lint/typecheck/test (78 tests)/build green; worker bundles (2.6MB).
  Open: inbound (item 6) — needs the `updates.email_meta` thread id wired
  from Message-ID, and bounce handling (item 5 follow-up, marks contact
  bounced) when inbound lands.
- **2026-08-31 (audit follow-up)** — Cleared the `pnpm audit` job failures
  (was 11 vulns: 1 critical, 2 high, 8 moderate). Bumped `vitest` ^2.1.0 →
  ^3.2.6 (resolved 3.2.7; clears the critical Vitest-UI advisory and the
  vite 5.4.21 / esbuild 0.21.5 cluster it pulled in), `esbuild` ^0.24.0 →
  ^0.25.0 (resolved 0.25.12), `@fastify/static` ^8.0.0 → ^10.1.2 (resolved
  10.1.3; no code changes needed — usage is `{ root }` + `sendFile`). The
  last path, `drizzle-kit > @esbuild-kit/core-utils > esbuild@0.18.20`
  (esbuild-kit is unmaintained, drizzle-kit 0.31.10 is still latest), is
  pinned with a nested pnpm override
  `@esbuild-kit/core-utils>esbuild: ^0.25.12` in the root `package.json`
  (`pnpm.overrides`). `pnpm audit` is now clean. Verified: lint/typecheck/
  test (46 tests, incl. vitest 3 in all 5 test packages)/build green, plus a
  live HTTP smoke of SPA static serving + deep-route fallback on
  `@fastify/static` 10.
- **2026-08-31** — Fixed the failing CI build (run 6 on `dd8e23e`: `pnpm test`
  → `database "kipple" does not exist`). Root cause: `10ca00b` replaced the
  `env` block in `apps/api/vitest.config.ts` (which injected
  `DATABASE_URL`/`AUTH_SECRET`/`PUBLIC_URL` into test workers) with just
  `fileParallelism: false`, and turbo only passes env vars to tasks that are
  declared in the task config — so the CI job's `DATABASE_URL` never reached
  the api test workers and they fell back to the default
  `postgres://kipple:kipple@localhost:5432/kipple`, which exists on dev
  machines (masking it) but not in CI (service container only creates
  `kipple_test`). Verified the stripping empirically (undeclared var →
  dropped; declared via task `env` → passed). Fix: declared
  `DATABASE_URL`/`AUTH_SECRET`/`PUBLIC_URL`/`REDIS_URL`/`MIGRATIONS_FOLDER`/
  `SPA_ROOT`/`PORT`/`HOST` in the `test` + `dev` task env in `turbo.json`,
  and restored `testTimeout: 30000` / `hookTimeout: 60000` in the vitest
  config. Verified with a cold repo copy: with CI env the api tests migrate +
  run against `kipple_test` (13 tables); without env they use the local
  `kipple` dev DB. lint/typecheck/test/build all green. Open follow-up: the
  `audit` job (non-blocking, `continue-on-error`) reports 11 vulnerabilities
  — vitest 2.1.9 (critical, UI server file read, patched in 3.2.6), vite
  5.4.21 via vitest (high), `@fastify/static` 8.3.0 (high path traversal +
  moderate, patched in 10.1.1/10.1.2); clearing needs a vitest 3.x +
  `@fastify/static` 10.x bump — done, see next bullet.
- **2026-08-30 (second session)** — Finished the ticket domain API. Fixed the
  red domain test: better-auth signs session tokens (`{random}.{sig}`), so the
  fixture now inserts a credential account (issuer `local:credential`,
  accountId = user id, `hashPassword` from `better-auth/crypto`) and signs the
  contact in for real. Added `GET /api/users` (staff-only list, feeds the
  assignee picker) + tests. Isolation fixes in `routes/tickets.ts`: contact
  users no longer receive internal updates or deleted tickets (list + detail),
  and updates now carry the author's name. Built the agent workspace UI
  (item 7): queue pane with status filters/counts, search + `/` shortcut,
  ticket detail with status/priority/assignee/tags controls, timeline,
  public/internal composer, new-ticket modal, stats tiles, 30s polling.
  Added vitest to `@kipple/web` with unit tests for the queue helpers.
  Verified: lint/typecheck/test all green (29 api, 6 web tests) plus a live
  HTTP smoke (setup → client → contact → ticket → reply, SPA served by the
  API). Committed: API half in `10ca00b`, workspace UI + this doc in `b42b5db`.
- **2026-08-30** — Theme system shipped: token contract (13 tokens), 4 themes
  (console/graphite/slate/blush), `users.theme`/`users.color_mode` +
  `settings.theme` plumbing, `PATCH /api/preferences`, registry↔CSS sync test.
  Blush (pink, both surfaces) added. Started and built the ticket domain
  (plan items 1–4: routes, access scoping, audit, `users.contact_id`,
  migration 0002, domain tests).
- Phase 0 completed across recent sessions: repo scaffold, CI/CD + GHCR,
  Drizzle schema + migrations, better-auth + setup wizard, RBAC, web shell,
  compose for Portainer. Aliases + channel priority locked in PLAN.md.

## Open questions / decisions

- Ticket number source: Postgres sequence (`ticket_number`) — shipped;
  alias = `support+{number}@{domain}` where domain comes from `settings` key
  `email` (fallback `kipple.local` until email settings exist).
- Out-of-scope resource requests return 404 (not 403) for contact users so
  client ids/ticket ids of other clients are not enumerable.
- Contact users can create tickets + public updates on their clients; all
  other mutations are staff-only (requireRole superuser/admin/agent).
- Deleting a client is blocked (409) while it has tickets; ticket delete is
  soft (status `deleted`) to preserve email history.

## How to use this file

1. Read this file at the start of every session.
2. Work the "active plan" table top-down; update statuses as you go.
3. Before committing: add a dated "recent sessions" bullet and adjust the table.
4. If the plan itself changes (scope, direction), update `docs/PLAN.md` too and
   note it here.
