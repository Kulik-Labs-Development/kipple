# AGENTS.md

## Project overview

Kipple is an open-source, self-hosted ticketing and client-portal platform for
managed service providers (MSPs). It replaces legacy PHP ticketing (e.g.
osTickets) with a modern, API-first system.

Core capabilities (see `docs/PLAN.md` for the full roadmap):

- Single instance per MSP (NOT multi-tenant): clients -> contacts -> tickets.
  Scaling to more MSPs = running more instances, each with its own database.
- Email-first ticketing: full ticket conversations conducted over SMTP/IMAP
- Agent workspace with a tech-forward, console-style default UI (monospace,
  command palette, keyboard-first) + white-labeled client portal
- Signup: first-run setup wizard (owner), admin-invited agents, optional
  domain-gated client self-registration (off by default)
- Passwordless magic-link login: default for client contacts, opt-in for
  staff; unavailable for users whose auth source is SSO
- Notification streams: one event pipeline, many channels (in-app, email,
   Slack/Teams/Discord/Mattermost/web push) with per-stream event,
   client, and priority filters. Agents work inside the app: in-app is the
   primary agent channel; email to agents is an away-from-desk fallback
   (minimal default, per-agent opt-in per event)
- Time tracking (billable/non-billable, per ticket, per agent, per client)
- Enable-able SLA feature: named policies, per-client and per-ticket
  assignment (ticket -> client -> instance-default precedence), business-hours
  aware
- Contacts link to one or more client companies (one primary), so a person
  can belong to multiple companies
- Console-style agent dashboard (live stats: assigned/opened/responded/
  closed/deleted/overdue, sparklines) + agent presence/status
- Superuser role with low-level instance settings (helpdesk name/status,
  logo/favicon, uploads & max size, language, URL blocklist, profile pictures)
- Auth: local users (TOTP MFA) + SSO (OIDC/SAML) with built-in IdP presets
  (Entra, Google, Zoho, Okta, OneLogin, Duo, Huntress ITDR, Keycloak) and a
  people-mapping wizard; hybrid or enforced modes
- Public REST API v1 (OpenAPI) + MCP server for agentic tooling
- Integration provider framework (UniFi Talk contact sync, BookStack KB)
- BookStack integration: per-client shelf/book links + "Summarize & log to
  BookStack" (BYO-key AI assist or manual template); no built-in KB
- Docker Compose deployment, target host: Portainer-managed stacks

## Status

**Phase 0 complete.** Live: monorepo scaffold, CI/CD + GHCR image
builds, Postgres schema (Drizzle, migrations auto-run on api boot),
better-auth (email+password, TOTP 2FA plugin, sessions, signups closed
after first user), first-run setup wizard (owner account → superuser,
instance name in `settings`), RBAC skeleton (role column + requireUser/
requireRole helpers), theme system (token-swap themes in `packages/ui`,
instance theme in `settings`, per-user theme/color-mode preferences), and
the web setup/login/workspace screens.

**Phase 1 in progress:** ticket domain API is live (clients, contacts with
M2M client links + primary, tickets with sequence numbers + plus-addressed
aliases, public/internal updates), client scoping enforced in the query
layer (`apps/api/src/access.ts`, out-of-scope = 404), audit log on
mutations, `users.contact_id` for portal users, email outbound pipeline (§5b:
provider queue + generic SMTP, `email_outbox` log, retry/backoff,
encrypted at-rest SMTP creds). Email inbound is live (worker IMAP IDLE +
thread matching: References → alias → subject tag → contact, Message-ID
dedupe in `email_messages`, no match → new ticket). Client portal +
magic-link login are live (better-auth `magicLink` plugin wired to the
outbox; only local contact accounts get a link; `POST /api/contacts/:id/portal`
provisions portal users; public sign-up blocked at the route once users
exist; web PortalView + role-based routing). Time tracking v1 is live
(`time_entries`, one running timer per agent = `duration_s IS NULL`,
billable flag, manual entries, client-scoped API + TimePanel in the
workspace with a `T` shortcut). The SLA backend is live (plan item 10):
enable-able, OFF by default, `sla_policies` with per-priority
response/resolve targets in business minutes, precedence
ticket > client > instance default, minute-stepped business-hours math in
`@kipple/shared`, at-risk/breach/met state machine driven by a 60s worker
tick, `system` timeline events + audit rows, SLA fields stripped from
contact responses; workspace UI shows response/resolve chips with
business-minutes countdown, per-ticket policy override, queue SLA badges,
 and a superuser SLA manager (enable, business hours, policies).
Item 11 is live: email templates (`email_templates`, 4 defaults seeded
at setup, all disabled, `{{dotted.path}}` rendering, preview endpoint),
a rules engine (`rules`/`rule_runs`: event match → one action
send_template/assign/add_tag/set_status/webhook-HMAC, fired from the
ticket routes, `POST /api/rules/test` dry-run preview), the in-app
notification center (`notifications`, fan-out to the assignee only —
 assigned/reply/status change/SLA breach), self-service presence
(`PATCH /api/me/presence`), and the workspace UI (notification bell,
superuser Automation manager with template + rules editors and a
"what would fire" test panel, presence picker, overdue tile + 14-day
opened/closed sparklines). Per-client portal branding is live (plan item
12): `clients.branding` = `{themeId?, accent?, logoUrl?}` (portal-surface
themes only, validated at the API); the portal resolves
user-pref > client branding > instance theme, the accent token and client
logo apply to the portal only, and a superuser/admin `ClientManager`
modal edits it. That completes the 12-item Phase 1 plan table.
Attachments on updates are live at v1 (plan item 13): multipart uploads
on `POST /api/tickets/:id/updates` (1–10 files, `ATTACHMENT_MAX_MB`
per-file cap), local-disk storage on the `storage-data` volume, and
client-scoped download/delete endpoints; chunked (tus) uploads and the
S3 adapter are backlog (row 18). The remaining PLAN.md Phase 1 scope
(hold states, staff client restriction, agent invites, client
self-registration) is backlog, then Phase 2 (API + MCP + integrations).
Update this file as each phase lands.

**Rolling build state:** read `docs/STATUS.md` at the start of every session
(active plan, what's live, open questions) and update it — including a dated
"recent sessions" bullet — before committing, so other sessions pick up the
same context.

## Repository layout

```
kipple/
  apps/
    api/        Fastify REST API (TypeScript, Drizzle ORM, PostgreSQL)
    worker/     Background jobs (email ingest, SLA ticks, webhooks) — BullMQ/Redis
    web/        React + Vite SPA: agent workspace and client portal
    mcp/        MCP server (stdio + streamable HTTP)
  packages/
    shared/     Zod schemas, types, constants shared by all apps
    ui/         Shared React components + design tokens
    mail/       Email parsing/threading helpers (imapflow, mailparser)
  docker/       Dockerfiles (api, worker, mcp)
  deploy/       docker-compose.yml (BYO proxy), docker-compose.proxy.yml
                (bundled Caddy), Caddyfile, .env.example
  docs/         PLAN.md, API reference, deployment guides
  .github/      CI (lint/typecheck/test) + image builds to GHCR
  logos/        Brand assets
```

## Setup commands

pnpm + Turborepo monorepo:

```sh
pnpm install                 # install all workspace deps
pnpm dev                     # run api + web + worker in dev (Docker for Postgres/Redis)
pnpm --filter @kipple/api dev
pnpm --filter @kipple/web dev
docker compose -f deploy/docker-compose.yml up -d db redis mailpit   # dev data stores; Mailpit = local SMTP/IMAP
```

## Build / lint / test

```sh
pnpm lint                    # ESLint across all workspaces
pnpm typecheck               # tsc --noEmit across all workspaces
pnpm test                    # Vitest across all workspaces
pnpm test -- --filter @kipple/api -t "name"   # single test
pnpm build                   # production builds
docker compose build         # rebuild images
```

A change is not done until `pnpm lint && pnpm typecheck && pnpm test` pass.
Add or update tests for the code you change, even if nobody asked.

## Code style

- TypeScript strict mode everywhere; no `any` without an explicit `// why:` comment
- Single quotes, no semicolons, trailing commas (enforced by ESLint/Prettier)
- Zod schemas in `packages/shared` are the single source of truth; API route
  handlers validate request/response bodies against them and the OpenAPI spec
  is generated from them
- Drizzle ORM for all SQL; no raw queries except migrations
- Functional style, small exported functions; no barrel-file god-exports
- Design tokens live in `packages/ui`; the agent app defaults to the
  monospace "Console" theme and the client portal to a sans-serif theme.
  A theme is one CSS file in `packages/ui/themes/` overriding the semantic
  token set (`--color-ink/panel/line/fg/dim/accent/ok/warn/danger`,
  `--font-app/mono/sans`, `--radius-app`) under `data-theme`/`data-mode` on
  `<html>`; theme ids are registered in `@kipple/shared` (`THEMES`) and a
  test keeps the registry and CSS files in sync. New theme = one CSS file +
  one registry entry. Components use only semantic utilities (`bg-ink`,
  `text-fg`, `border-line`, `text-accent`) — never raw color values
- Errors: throw typed domain errors from `packages/shared`, mapped to HTTP
  status codes by a single API error handler
- No console.log — use the pino logger from the api/worker bootstrap

## Data isolation rules

- The system is single-tenant: one instance, one database, one MSP.
- The only isolation boundary is client: a client contact may only ever see
  data belonging to their own `client_id`; staff see all clients unless
  restricted to a client set (per-client access scoping) — enforce scoping
  in the query layer, never the UI.
- Never write a query that can surface another client's data to a contact.
  Enforce client scoping in the query layer, not just the UI.
- Client-scoping tests are required for any new query-touching feature.
- API keys, webhooks, and portal sessions are instance-scoped.

## Email handling rules

- No auto-responses baked in: all automated email must flow through
  user-configured templates + rules. Nothing ships enabled by default. If a
  task seems to need a "nice to have" auto-reply, make it a template + rule
  the user can create, not code that sends.
- Never mutate email-derived data without idempotency keys (Message-ID).
- Thread matching order: Message-ID/References -> ticket alias (the +tag in
  the To header, e.g. `support+1042@`) -> subject tag -> contact fallback.
  All logic lives in `packages/mail`, covered by unit tests with fixture
  `.eml` files.
- Ticket aliases are plus-addressed (`support+{ticket}@yourdomain.com`); no
  subdomains or catch-alls. All outbound public replies set `Reply-To` to
  the ticket alias so client replies route back into the system.
- Never log full email bodies or message IDs containing secrets; log metadata only.
- ALL outbound email goes through the provider queue + `email_outbox` log
  (see PLAN.md §5b) — never direct SMTP calls outside `packages/mail`
  provider code. Providers: generic SMTP, Microsoft 365 OAuth2 (M365 has no
  basic-auth SMTP), Google Workspace.
- Uploads target chunked (~5–10MB, tus-compatible) transport so they
  work behind Cloudflare's 100MB free-tier cap and any proxy (item 13 v1
  ships single-request multipart with a per-file cap; tus/S3 = backlog
  row 18).

## Security considerations

- Secrets only via environment variables (`.env`); `deploy/.env.example` documents every var.
- Never commit secrets, fixtures with real PII, or API keys.
- SMTP/IMAP and integration credentials are instance settings, stored encrypted at rest.
- Webhook payloads are HMAC-signed; inbound webhooks verify signatures.
- User identity is stable: everything references `users.id`. SSO conversion
  (people mapping) only changes the auth source on the user, never the id —
  never write code that re-points assignments/timestamps during a merge.
- Enforced SSO must always retain at least one local MFA break-glass admin;
  that account can never be converted.
- Run `pnpm audit` after dependency changes; pin major versions in lockfile only.

## Deployment

- Production target: Docker Compose stack managed through Portainer.
  `deploy/docker-compose.yml` and `deploy/docker-compose.proxy.yml` must stay
  single-host, no external deps beyond Postgres + Redis, all config via env
  vars, healthchecks on every service. Both are self-contained single files
  (Portainer CE deploys one file per stack) — keep their core services in
  sync.
- Reverse proxy is BYO-first: the default compose exposes no public ports.
  `deploy/docker-compose.proxy.yml` adds a bundled Caddy (auto-HTTPS) for
  hosts without one. The app must work behind ANY proxy — no hard dependency.
- The API container also serves the built SPA: one entry point. `PUBLIC_URL`
  is the only source of the public address (email links, OIDC/SAML redirects,
  webhooks, MCP); proxy headers are honored only when `TRUST_PROXY` is set.
- DB migrations run automatically on api startup (Drizzle).
- Keep images multi-stage, non-root, and < ~200MB per service.

## Commit / PR conventions

- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`
- PR title format: `[scope] Title` (e.g. `[api] add ticket alias routing`)
- Always run `pnpm lint && pnpm typecheck && pnpm test` before committing.
- Schema changes require a migration in the same PR.
