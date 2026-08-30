# STATUS

Rolling build state for Kipple. **Every work session must read this first and
update it (plan table + recent sessions) before committing**, so any other
chat or contributor can pick up where work left off. Deep design lives in
`docs/PLAN.md`; conventions in `AGENTS.md`.

## Current phase

**Phase 1 — Core ticketing.** Phase 0 (foundation) is complete.
Next up: email outbound pipeline (§5b) — generic SMTP provider first,
then M365 OAuth2.

## What's live

- Monorepo (pnpm + Turborepo); CI (lint/typecheck/test) + GHCR image builds on push
  (`ghcr.io/kulik-labs-development/kipple/{api,worker,mcp}`; Portainer deploys from
  `infra/docker-compose.yml`, needs `KIPPLE_TAG` + GHCR PAT `read:packages` + `AUTH_SECRET`)
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

## Phase 1 — active plan

| # | Item | Status |
|---|------|--------|
| 1 | Ticket domain API: clients, contacts (M2M with primary client), tickets (number + alias), updates (public/internal) | done |
| 2 | Client scoping in query layer + mandatory client-scoping tests (contact users only ever see their own client's data) | done |
| 3 | Audit log on all mutations | done |
| 4 | `users.contact_id` link so portal users map to contact records | done |
| 5 | Email outbound: provider queue (§5b) — generic SMTP first, then M365 OAuth2 (adoption gate) | not started — NEXT |
| 6 | Email inbound: worker IMAP IDLE (imapflow) + mailparser, Message-ID dedupe, thread matching (References → alias → subject tag → contact), no match → new ticket | not started |
| 7 | Agent workspace UI: queue, ticket detail with update timeline, reply, status/priority/assign/tags | done (SLA timers arrive with item 10) |
| 8 | Client portal + magic-link login for contacts (portal users hard-scoped to their clients) | not started |
| 9 | Time tracking v1 (billable/non-billable per ticket/agent/client) | not started |
| 10 | SLA feature (enable-able, OFF by default; per-client/per-ticket policy precedence) | not started |
| 11 | Email templates + rules v1 (nothing auto-sends by default), notification center, dashboard stats + presence | not started |
| 12 | Per-client branding override for portal theme (uses `clients.branding`) | not started |

## Recent sessions

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
