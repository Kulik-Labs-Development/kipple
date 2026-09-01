# Kipple — Project Plan

Name: **Kipple**.
Open-source, self-hosted ticketing + client portal for MSPs. API-first, with
MCP support, email-native ticketing, and a one-click Docker Compose deploy
targeting Portainer.

---

## 1. Vision

Replace legacy PHP ticketing (osTickets) with a system that an MSP can:

1. Run for their own client base (white-label portal, many clients per instance)
2. Extend via a public REST API + MCP (so any AI agent or tooling can work tickets)
3. Operate end-to-end over email (client replies by email, no portal login needed)
4. Track billable time per ticket/agent/client and export it for invoicing
5. Sync identity data with existing infrastructure (first: UniFi Talk)

**Explicit non-goals:**
- Client credential vault — deliberately out of scope (use a dedicated
  secrets tool); do not propose it as a feature

**Deployment model: single-tenant by design.** One instance serves one MSP and
all of its clients. There is no tenant column, no cross-MSP isolation layer, no
tenant scoping to build or test. If we ever host this for other MSPs, we run
one instance (own database, own storage) per MSP — the deploy unit is the
instance, which is exactly what the Docker Compose / Portainer story gives us
for free.

## 2. Users & roles

| Role | Where | Can |
|---|---|---|
| **Superuser** | Agent app | Everything, incl. low-level instance settings (branding, helpdesk status, uploads, language, security) — see §6b |
| Admin | Agent app | Manage agents, clients, SLAs, integrations, day-to-day ops |
| Agent | Agent app | Work tickets, time tracking, KB, notes |
| Client contact | Client portal / email | Open tickets, reply, view own client's tickets, request forms |
| API consumer | REST API / MCP | Scoped read/write via API keys or MCP tokens |

Staff (superuser/admin/agent) see all clients. Client contacts are hard-scoped
to their own client's data — that is the only isolation boundary in the system.

## 3. Phases

### Phase 0 — Foundations (week 1–2)
- pnpm + Turborepo monorepo scaffold (apps: api, web, worker, mcp; packages: shared, ui, mail)
- Fastify + Drizzle + Postgres 16 + Redis; pino logging; ESLint/Prettier/Vitest
- Docker: multi-stage Dockerfiles, `deploy/docker-compose.yml` + `deploy/docker-compose.proxy.yml` (db, redis, api serving the built SPA, worker, mailpit/adminer for dev)
- CI (GitHub Actions): lint, typecheck, test, build images
- Auth (better-auth): email+password, TOTP MFA, sessions
- **First-run setup screen:** empty instance -> setup wizard (instance name,
  owner account) -> normal app. No accounts = setup; accounts exist = login
- RBAC skeleton (superuser/admin/agent/contact)

**Exit criteria:** `docker compose up` gives a working login + empty agent app.

### Phase 1 — Core ticketing MVP (weeks 3–8)
- Domain model: clients <-> contacts (many-to-many, one primary per contact)
  -> tickets -> updates (public/internal) + attachments
- **Company association for contacts:** a contact can be linked to multiple
  clients/companies (owner running 3 companies, shared IT person, parent +
  subsidiaries) with exactly one **primary** company. Contact name is always
  shown with its company (queue, ticket view, portal); contact lists filter
  by company; tickets default to the primary company, overridable at
  creation
- Agent workspace: queue, ticket detail, status/priority, assign, tags, SLA timers
- Client portal: open ticket, reply, view tickets, profile
- Ticket workflow: "Waiting on client" / "Waiting on vendor" hold states
  with hold timers; auto-close after X days on hold (pre-close warning via
  template + rule)
- Per-client access scoping: staff can be restricted to a set of clients
  (enforced at the query layer, same rule as contact isolation);
  unrestricted by default
- **Email conversations:**
   - Instance support mailbox + ticket aliases via plus-addressing
     (`support+1042@yourdomain.com`) — no subdomains, catch-alls, or extra DNS
   - Worker: IMAP IDLE ingest (imapflow), mailparser parsing, thread matching
     (Message-ID/References -> alias -> subject tag -> contact fallback),
     idempotent by Message-ID
  - SMTP send (nodemailer): public replies threaded correctly, internal notes never emailed
  - **No auto-responses baked in:** every automated email is driven by
    user-configured templates + rules; nothing ships enabled by default
- Instance settings: business hours, SMTP/IMAP email config, notification prefs
- **SLA feature (enable-able, off by default):**
  - Named SLA policies: per-priority response/resolve targets,
    business-hours aware (instance business-hours config)
  - Assignment precedence: per-ticket policy (explicit override) ->
    per-client policy (set on the client) -> instance default policy
  - Tickets carry the resolved policy + response/resolve due times; queue
    and dashboard show countdown, at-risk, and breached states
  - SLA events (at-risk / breached / met) feed the §8d notification catalog
- Agent dashboard ("stats for nerds"): console-style stat tiles — assigned to
  me, in queue, opened, responded, closed, deleted, overdue, SLA at risk;
  sparklines (opened/closed by hour, avg response time); live via SSE, cheap
  Postgres aggregates; **agent presence/status** (online/away/busy/offline,
  set manually or auto-away) shown on tickets and in queues
- In-app notification center (bell + live SSE) with per-agent event
  preferences — the "my" subset of the §8d event catalog; the primary
  agent-facing channel (email to agents = away-from-desk fallback, §8d)
- Accounts & signup:
  - Agents: admin-invited (email token link, MFA on first login); admin can
    disable signups entirely
  - Clients: optional self-registration gated by per-client allowed email
    domains (e.g. `@clientcorp.com`) — **off by default**, admin enables per
    client
- **Magic link login (passwordless):**
  - Client contacts default to magic link: enter email -> link -> signed in;
    no password to track
  - Staff: password + MFA stays the standard; magic link is an opt-in per
    account, with a superuser policy setting to allow/deny staff magic links
  - **Unavailable whenever the user's auth source is SSO** (SSO enabled for
    that user or enforced) — SSO users sign in via IdP only
  - Security: single-use tokens, ~10 min expiry, per-email rate limiting,
    no account enumeration, optional "trust this device" cookie (ignored for
    SSO users)
- Time tracking v1: start/stop timer on ticket, manual entries, billable flag
- Built-in branding: 3–4 themes (e.g. "Slate", "Ocean", "Ember", "Mono") + dark mode,
  instance logo/color overrides (optional per-client overrides), theme switcher in portal settings
- Email templates + rules v1:
  - Editable email templates (new ticket, reply, close, CSAT, ...) — all
    optional, **none active by default**
  - Rules/filters: match (new ticket, status change, tag, priority, sender,
    client) -> action (send template, assign, tag, change status, webhook)
  - Rules disabled until the user creates and enables one; UI makes explicit
    what would fire ("test rule" preview)
- Audit log for all mutations

**Exit criteria:** A client opens a ticket from the portal, agent replies, client
replies by email, thread stays in one ticket, time tracked, all white-labeled,
and zero automated emails sent unless the admin configured a rule.

### Phase 2 — API + MCP + integrations (weeks 9–12)
- **Microsoft 365 outbound mail provider** (OAuth2 client credentials via
  Graph or OAuth2 SMTP, setup wizard) — §5b; high priority: if your mail is
  M365, this gates the osTickets migration
- REST API v1: OpenAPI 3.1 generated from shared Zod schemas; API keys with scopes;
  rate limiting; interactive docs page
- Webhooks: outbound (HMAC-signed, retry with backoff) and **inbound
  monitoring -> ticket**: NMS alerts (PRTG, Zabbix, Watcher, UptimeRobot,
  custom) auto-create tickets, HMAC-verified, deduped per alert signature
  (repeat alert updates the open ticket instead of spawning new ones)
- **MCP server** (`apps/mcp`): stdio + streamable HTTP. Tools:
  `search_tickets`, `get_ticket`, `create_ticket`, `add_reply`, `add_note`,
  `list_contacts`, `create_contact`, `search_contacts`, `start_timer`,
  `stop_timer`, `list_time_entries`, `list_clients`, `get_report`
- **Integration provider framework:** versioned provider interface
  (list/sync upsert/delete, field mapping, sync log, manual + scheduled sync).
  First provider: **UniFi Talk** contact sync (create/update/delete Talk users
  from contacts, match by email/phone, per-instance UniFi Talk credentials,
    optional: pull call log and attach calls to tickets via their API).
- **Tactical RMM integration** (open source, first-party REST API):
  per-instance RMM URL + API key; deep links — "open machine in RMM" from
  ticket and asset views; generic **external-links** fields on clients and
  assets for any platform (RMM, monitoring, billing). Later: pull
  computers/agents from the RMM into the asset model
- **BookStack integration (the knowledge base — we don't build our own):**
  per-instance BookStack API token, per-client shelf/book links with a
  BookStack icon on all client surfaces, MCP read/write tools, and the
  "Summarize & log to BookStack" ticket button (BYO-key AI assist or manual
  template mode) — see §8e

**Exit criteria:** An MCP client (e.g. opencode/Claude) can find, read, and
update a ticket using only the MCP tools; UniFi Talk contacts stay in sync.

### Phase 3 — Power features (weeks 13–18)
- Assets / CMDB-lite: devices, services, licenses; link to tickets & clients
- Automation rules engine v2: advanced conditions (SLA breach, time
  thresholds, keyword match) and actions (escalation chain, SLA change,
  reassign, notify); builds on the Phase 1 rules foundation
- SLA engine v2: escalation chain (nudge assignee -> reassign -> notify
  admin), per-service SLAs, SLA change via rules — builds on the Phase 1 core
- Reports: tickets opened/resolved/MTTR, agent load, time tracked & billable
  per client, CSAT; CSV export
- **Monthly client report:** auto-generated per client (tickets, MTTR,
  billable time, CSAT, top causes once the cause taxonomy lands), emailed
  on the 1st + viewable in the client portal
- CSAT email surveys on ticket close
- **Invoice Ninja provider** (optional billing, off until configured): draft
  invoices from billable time via the IN v6 API — see §8b
- osTickets importer: contacts, tickets, notes (CSV/DB extract), dry-run mode
- Request forms / ticket templates in portal ("Password reset", "New user", ...)
- Chat widget embeddable on client sites (WebSocket/SSE)
- Full-text search (Postgres FTS to start; swap to Typesense later if needed)
- **SSO:** OIDC + SAML with built-in IdP presets (Entra ID, Google
  Workspace, Zoho Directory, Okta, OneLogin, Duo, Huntress ITDR, Keycloak),
  people-mapping wizard, hybrid/enforced modes — see §7b
- **Notification streams & chat channels:** Slack, Teams, Discord, Mattermost,
  generic webhook (+ web push), per-stream event/client/priority filters,
  digests & rate limits, delivery log + test send — see §8d

### Phase 4 — Open-source & productization (**deferred**)

Build the solid core product (Phases 0–3) first; productization comes later.
Park here when we get there: license decision (MIT vs Apache-2.0) + DCO,
docs site, demo instance, optional hosted signup (one instance per signing-up
MSP), Helm chart, 0.x release + contribution guide.

## 4. Architecture

```
                     ┌────────────────────────────────────────────┐
 Browser             │                Portainer host              │
 ┌──────────┐  ┌─────┴──────┐        ┌─────────┐   ┌──────────┐  │
 │ Agent app│  │ Client      │        │  Mail   │   │ UniFi    │  │
 │ (React)  │  │ Portal      │        │ (SMTP/  │   │ Talk API │  │
 └────┬─────┘  │ (React)     │        │  IMAP)  │   └────┬─────┘  │
      │        └─────┬──────┘        └────┬────┘        │        │
      │              │                    │             │        │
 ┌────▼──────────────▼────────────────────▼─────────────▼─────┐  │
 │                        Fastify API                          │  │
 │  REST v1 (OpenAPI) · sessions · API keys · RBAC · webhooks  │  │
 └────┬─────────────────────────────┬─────────────────────────┘  │
      │ SQL                         │ jobs (BullMQ)               │
 ┌────▼─────┐  ┌──────────────┐  ┌──▼───────────────────────┐    │
 │ Postgres │  │   Redis      │  │ Worker: IMAP ingest,     │    │
 │ (Drizzle)│  │ (queues)     │  │ SLA ticks, webhooks,     │    │
 └──────────┘  └──────────────┘  │ integration syncs        │    │
                                 └──────────────────────────┘    │
 ┌──────────────────────────────────────────────────────────────┐
  │ MCP server (stdio + HTTP) — thin client over REST API keys   │
  └──────────────────────────────────────────────────────────────┘
```

The agent app and client portal are ONE static SPA build served by the API
container — a single HTTP entry point for any reverse proxy. Runtime compose
services: db, redis, api, worker (+ `proxy` / `dev` profiles). TLS terminates
at the proxy (BYO or bundled — see §9).

### Stack (chosen for maintainability: one language end-to-end)

| Concern | Choice | Why |
|---|---|---|
| Language/runtime | TypeScript (strict), Node 22 LTS | One language for API, worker, web, MCP; Node for Docker/maturity |
| Monorepo | pnpm + Turborepo | Isolated builds, shared packages |
| API | Fastify 5 + Zod | Fast, schema-first; Zod schemas = validation + OpenAPI + MCP tool inputs (one source of truth) |
| ORM/DB | Drizzle ORM + PostgreSQL 16 | Type-safe, SQL-first, FTS/JSONB; migrations on boot |
| Queue/cache | Redis 7 + BullMQ | Durable jobs: IMAP ingest, SLA ticks, webhooks, syncs; sessions/cache |
| Frontend | React 19 + Vite + TanStack Router/Query | Modern SPA; no SSR complexity; static build behind edge proxy |
| UI kit | Tailwind v4 + shadcn/ui (Radix) | Components live in-repo (OSS ownership); themes = token swaps |
| Console UX | cmdk (command palette), TipTap (rich text) | Keyboard-first agent UI; modern editor for notes/email bodies |
| Realtime | SSE (upgrade to WS if chat widget demands) | Simple behind proxies |
| Auth | better-auth | In-process: sessions, TOTP MFA, invites; OIDC federation later |
| Email in | imapflow (IMAP IDLE) + mailparser | Maintained, real-time, solid parsing |
| Email out | nodemailer + Handlebars + juice (CSS inlining) | Reliable SMTP; inline styles for all mail clients |
| MCP | @modelcontextprotocol/sdk (official) | stdio + streamable HTTP; typed wrapper over REST, scoped API keys |
| API docs | Scalar on generated OpenAPI 3.1 | Modern, fast, embeddable |
| Search | Postgres FTS + pg_trgm | Zero extra services; Typesense later only if needed |
| Attachments | Local volume default + S3-compatible adapter | Simplest self-host; S3/MinIO when needed |
| Edge | Caddy (auto-HTTPS) in compose | Modern, tiny; Traefik fine if host already runs it |
| Testing | Vitest + Playwright + `.eml` fixtures | Unit/integration + e2e (esp. email→ticket) |
| CI | GitHub Actions (lint/typecheck/test/build) | |
| Logging | pino → stdout (Portainer logs); OTel later | Structured, cheap |
| Deploy | Docker Compose, single-host | Portainer-native; scale-out later via replicas |

Rejected alternatives (context for future debates): NestJS (too heavy),
Hono (viable, smaller ecosystem), Prisma (Drizzle is lighter/SQL-first),
Next.js (no SSR value here), Inngest/Temporal (extra service), Keycloak
(extra heavy dep; better-auth federates later), Meilisearch/Typesense
(premature vs Postgres FTS).

### Data model (core tables)

```
users(id, role, email, name, mfa, presence, auth_source, ...)  -- MSP staff
  -- presence = online/away/busy/offline; auth_source = local | sso:<provider>
clients(id, name, domain, branding jsonb?, sla_policy_id?, ...)  -- end-customer companies
contacts(id, name, email, phone, external_id?, ...)
  -- phone E.164
contact_clients(contact_id, client_id, is_primary)  -- M2M; exactly one primary per contact
tickets(id, client_id, alias, subject, status, priority,
        assigned_to, sla_policy_id, sla_response_due_at, sla_resolve_due_at,
        tags[], created_by, ...)
updates(id, ticket_id, author_id, kind: public|internal|system,
        body, email_meta jsonb, created_at)
attachments(id, update_id|ticket_id, storage_key, filename, size, mime)
time_entries(id, ticket_id, agent_id, client_id, started_at, duration_s,
             billable, note)
integrations(id, provider, config jsonb (enc), enabled)
sync_logs(id, integration_id, status, details jsonb)
api_keys(id, scopes[], hashed_secret, last_used_at)
webhooks(id, url, events[], secret)
audit_logs(id, actor_id, action, target, meta jsonb)
settings(key, value jsonb)                    -- instance settings (superuser, §6b)
email_outbox(id, ticket_id?, to, subject, provider, status, error, sent_at)  -- §5b
notification_streams(id, channel, target jsonb, events[], client_filter jsonb,
                    min_priority, quiet_hours jsonb, rate_cap, dedup_s, enabled)  -- §8d
notification_log(id, stream_id?, channel, event, status, error, created_at)   -- §8d
assets, services, rules, request_forms        -- Phase 3
bookstack: no local tables — external; clients carry the shelf/book ref
```

Single database per instance; no tenant column anywhere.

## 5. Email conversation design (the hard part)

1. **Routing in:** one support mailbox per instance (e.g. `support@`). Worker
   holds a single IMAP IDLE connection; on message: parse -> dedupe by
   Message-ID -> match:
   a) Message-ID/References in existing thread, b) ticket alias in To,
   c) ticket number in subject, d) known contact + heuristics. No match ->
   create ticket.
2. **Ticket aliases (plus-addressing):** every public reply carries
   `Reply-To: support+{ticket}@yourdomain.com`; on ingest we parse the +tag
   from the To header. No subdomains, catch-alls, or extra DNS — works as-is
   on M365 and Google Workspace. If a gateway strips the +tag, the
   References/subject/contact layers still route the reply.
3. **Routing out:** public updates -> outbound provider queue (§5b),
   `In-Reply-To` preserved, agent identity in `From`, `Reply-To` set to the
   ticket alias (item 2) so client replies re-enter the system; internal
   notes never leave the system.
4. **Deliverability:** instance settings hold the sending domain + SPF/DKIM
   guidance (docs); bounce/complaint handling marks contact as bounced.
5. **Dev story:** Mailpit in compose gives full SMTP+IMAP locally;
   fixture `.eml` files in `packages/mail` for thread-matching tests.

## 5b. Outbound mail workflow & providers (Microsoft 365 note)

Microsoft 365 no longer supports standard basic-auth SMTP AUTH, so outbound
mail is a pluggable provider + delivery pipeline, not a hard-coded SMTP call:

- **Provider interface:** `send()`, `testConnection()`, `status()`
- **Providers:**
  - Generic SMTP (no auth / basic auth, STARTTLS/TLS) — Phase 1 default;
    still fine for most providers and relays
  - **Microsoft 365 / Exchange Online** — Phase 2 (high priority): OAuth2
    client credentials (service principal + `Mail.Send` app permission,
    admin consent); send via Microsoft Graph or SMTP AUTH with OAuth2
    bearer — admin picks, and the setup wizard documents enabling
    `SmtpAuthAcceptanceOAuth2` on mailboxes. If your mail is M365 this
    gates migration from osTickets.
  - Google Workspace (OAuth2 SMTP)
  - Later: API-first providers (SendGrid, Mailgun, Postmark, SES)
- **Delivery pipeline (the workflow):** every outbound email (replies,
  rule-driven templates, CSAT) is enqueued in BullMQ -> provider ->
  per-message status (`queued / sent / failed / bounced`) with retry +
  backoff -> **email activity log** in instance settings (per-message,
  filterable, provider error detail) + one-click **test send** + bounce
  handling marks the contact as bounced
- **Inbound** stays IMAP (M365 still supports IMAP; Graph-based inbound is a
  later option if a customer needs it)
- Rule: no direct SMTP calls anywhere outside `packages/mail` provider code

## 6. Branding & theming

- Built-in themes as Tailwind token sets (color, radius, font) + dark mode
- Theme switcher: admin picks the theme; portal respects it; per-user
  light/dark override
- White-label layer: logo, favicon, accent color, portal subdomain
  (`portal.yourmsp.com` or path-based), email signatures
- Optional per-client branding override (client sees their own logo/color)
- Templates: request forms, email notices, and notification emails are
  editable in instance settings with safe variable substitution

### Agent workspace design language (tech-forward)

The agent app is used by tech teams — default it to a console/terminal
aesthetic for legibility and speed, keep the client portal clean and modern.

- **Default agent theme "Console":** dark background, monospace UI font
  (system mono stack: JetBrains Mono -> SF Mono -> Consolas -> monospace),
  tabular numerals, uppercase micro-labels, subtle grid texture
- LED-style status indicators (open / pending / SLA-breach / resolved),
  terminal-style ticket timeline (updates rendered like log entries with
  timestamps + actor)
- **Command palette (Ctrl/Cmd+K):** search tickets/contacts/assets, quick
  actions (new ticket, start/stop timer, jump to client)
- Keyboard-first queue: J/K navigate, `T` start/stop timer, `S` save,
  `/` focus search — all with a visible shortcut hint panel
- IDE-style **status bar** pinned to the bottom: queue counts, SLA warnings,
  email/integration sync state, active timer
- Console-adjacent themes for the agent app (e.g. "Console Amber", "Console
  Cyan", "Graphite"); client portal themes stay sans-serif and friendly
- All design tokens live in `packages/ui`; themes are pure token swaps
  (no per-theme component code)

## 6b. Superuser & instance-level settings

**Superuser** = top agent role (instance owner): full control, including
low-level instance options that Admin does not touch. Dedicated
superuser-only "Instance settings" area, grouped:

- **Identity & branding:** helpdesk name, logo, favicon (all feed the
  theme/white-label layer from §6)
- **Operations:**
  - Helpdesk status (online / offline) — offline suspends *new* ticket
    intake (portal + email show a notice and reject/queue per setting);
    agents can still work existing tickets
  - Primary language (i18n locale; all strings i18n-ready from day one)
  - Profile pictures on/off
- **Profile pictures:** **own uploads only** — no external avatar provider,
  so it works fully offline/self-hosted; when disabled, locally generated
  initials avatars; picture uploads reuse the chunked upload pipeline
- **Files & uploads:**
  - Permitted attachment types (MIME + extension allowlist, editable)
  - Max file size (configurable; must comfortably exceed 100MB)
  - Attachment audit log (who uploaded what, to which ticket, when;
    deletions recorded)
  - **Chunked/resumable upload pipeline:** uploads stream in ~5–10MB chunks
    (tus-compatible) so no single HTTP body hits Cloudflare's 100MB
    free-tier cap or any proxy timeout; server assembles to local volume or
    S3; optional direct-to-S3 signed-URL path for very large files that
    bypasses the app entirely
- **Security:** URL blocklist for shared links — deny dangerous schemes
  (`file://`, `gopher://`, ...), internal/link-local address ranges
  (SSRF guard), plus a configurable domain denylist
- Every settings change is audit-logged (who, what, old -> new value)

## 7. MCP support

- `apps/mcp` wraps the REST API with an API key (instance-scoped, least-privilege scopes)
- Transport: stdio (local agents) + streamable HTTP (remote agents)
- Read-only profile by default; write tools gated behind explicit opt-in
- This is the differentiator: any AI coding/support agent (opencode, Claude
  Code, etc.) becomes an operator of the help desk

## 7b. SSO & identity (IdP support)

Local users and SSO coexist (hybrid by default); the admin can later
**enforce** SSO (local password sign-in disabled).

- **OIDC-first:** generic OpenID Connect (issuer, client id/secret, scopes;
  redirect URI derived from PUBLIC_URL) — covers most modern IdPs
- **SAML 2.0 fallback:** generic SAML SP (`@node-saml/node-saml`) for
  SAML-only or legacy IdPs
- **Built-in presets** (pre-filled endpoints + claim-mapping templates;
  one-screen setup instead of blank fields):
  - Microsoft Entra ID, Google Workspace, Zoho Directory (Zoho One), Okta,
    OneLogin, Keycloak (self-hosted)
  - Duo (Duo Auth for SaaS, SAML), Huntress ITDR
  - "Custom OIDC" / "Custom SAML" escape hatches
- **People mapping wizard** (runs on first SSO enablement):
  1. Lists local users; auto-matches IdP identities by normalized email
  2. Admin confirms/overrides matches; surfaces unmatched IdP users AND
     unmatched local users
  3. **Conversion is auth-source-only:** `users.id` is stable forever —
     mapping flips the user's auth provider `local` -> `sso:<provider>`
     (optionally syncing the IdP email). Ticket assignments, time entries,
     notes, and audit history all reference `users.id`, so nothing is
     re-pointed and no data is lost. No row merges in the common case.
  4. Enforce-SSO leftovers: local users with no IdP match are flagged;
     admin chooses keep-local / disable / reassign open work
- **Safety rule:** enforced SSO must always leave at least one local MFA
  break-glass admin account (it can never be converted)
- **New IdP users:** on first SSO login, create a local user — optionally
  gated by allowed email domains / IdP groups so the IdP can't spray accounts
- **Multiple IdPs** can be active at once (e.g. Entra for staff + Google for
  contractors), each with its own domain/group rules
- **SCIM 2.0 (later):** automated provisioning/deprovisioning (Entra, Okta,
  OneLogin, Zoho all speak SCIM) so a leaver's open tickets are flagged for
  reassignment automatically

## 8. UniFi Talk integration (first provider)

- Provider interface: `discover()`, `syncContacts(direction)`, `delete()`, `status()`
- Sync contacts -> Talk users (create/update, match by email or phone),
  delete on contact removal (soft: disable first)
- UniFi Talk site/credentials stored in instance settings (encrypted),
  sync log UI, scheduled + manual sync
- Phase 3+: pull call log from UniFi Talk API, attach call records to tickets

## 8b. Invoice Ninja (optional billing provider)

Keep the billing engine in Invoice Ninja; Kipple captures time and drafts
invoices, it never bills:

- Same provider interface as UniFi Talk: per-instance IN server URL + API
  token (encrypted), disabled until the admin connects one
- Optional client/contact sync: Kipple client -> IN client, contact -> IN
  contact, matched by email; keeps names/addresses aligned
- Time -> draft invoice: select billable time entries, grouped by client
  (optionally by period or ticket) -> IN invoice created with **status DRAFT**
  - Line item: description from ticket subject + time-entry note, quantity =
    hours, rate from the rate card in settings (per client, per agent, or
    per service — admin's choice)
- Idempotency: time entries store the external IN invoice ID once invoiced and
  cannot be invoiced twice; re-running a batch is safe
- Kipple only ever creates drafts — sending, discounts, payment terms, and
  collection stay in IN (human decision, no surprise invoices)
- CSV export of time entries remains the universal fallback for QuickBooks,
  Xero, or spreadsheets

## 8d. Notification streams & chat channels

All notifications flow from ONE event pipeline (the same event source that
feeds webhooks in Phase 2); channels are just delivery targets:

```
domain events -> notification dispatcher (worker) -> channels
(ticket.*, sla.*, contact.*, time.*, system.*)
```

**Channel priority:** agents work inside the app — in-app (later web push)
is the primary agent channel; email to agents is an away-from-desk
fallback (minimal default: assigned to me, mentioned, SLA breach — agents
opt in to more, per event). Client contacts get email as a first-class
channel: they open and reply without a portal login.

- **Channels:**
   - In-app (SSE live updates + notification center) — Phase 1 — primary
     agent channel
   - Email — Phase 1 (existing pipeline, §5b) — first-class for client
     contacts; away-from-desk fallback for agents
  - **Chat (Phase 3), v1 via incoming webhooks (no app registration):**
    - Slack (#channel webhook), Microsoft Teams (MessageCard webhook),
      Discord (webhook), Mattermost (Slack-compatible webhook),
      generic JSON webhook (covers the long tail)
   - Web push (agent app, VAPID) — Phase 3
  - Backlog: Slack/Teams interactive bots (per-ticket threads, reactions),
    Matrix homeserver
- **Streams (config objects):** a stream = channel + target + filters:
  - Event types (catalog below), client filter (all / specific / exclude),
    minimum priority, quiet hours, per-stream rate cap, dedup window
  - Multiple streams per channel (e.g. urgent-only to #incidents, full
    stream to #helpdesk)
- **Event catalog (each toggleable per stream):**
  - *Ticket:* new, new client reply, new internal note, assigned, status
    changed, reopened, closed, deleted, unassigned > X hours, stale (no
    update > X days)
  - *SLA:* at risk (default 25% of time remaining), breached, met,
    escalation triggered
  - *Clients & contacts:* email bounced/complaint, low CSAT (<= 2/5),
    new contact (admin stream)
  - *Time:* time entry added (billing-review stream)
  - *System:* integration sync failed, outbound email failed, settings
    changed (superuser stream), helpdesk status changed, new SSO user,
    repeated auth failures
- **Per-user preferences (agent app):** *my* events (assigned to me,
   mentioned, reply on my ticket) always reach me in-app; email / web push
   delivery is per-agent, per-event opt-in with a minimal away-from-desk
   default (assigned, mentioned, SLA breach); client contacts keep their
   portal email prefs
- **Noise control:** dedup window per ticket+event, per-stream rate cap,
  optional hourly/daily **digest** for low-priority streams, quiet hours
- **Ops:** delivery log per notification (channel, event, status, error) +
  one-click test send per stream; configured in instance settings (superuser)

## 8e. BookStack integration (knowledge base)

BookStack is already great — we integrate, we don't rebuild. BookStack has a
solid first-party REST API, which makes this a clean provider:

- **Connection:** per-instance BookStack server URL + API token (encrypted),
  connection test + shelf/book browser in instance settings
- **Per-client documentation link:** clients store a BookStack shelf/book
  reference (picked from the live list); a BookStack icon appears on every
  client surface — client detail, ticket header for that client's tickets,
  command-palette results — opening the client's docs directly
- **"Summarize & log to BookStack" button** on a ticket (closed tickets
  recommended):
  1. Uses the optional **BYO-key AI assist** (any LLM provider —
     OpenAI/Anthropic/local endpoint; nothing ships configured). The same
     assist can draft replies and summarize long threads.
  2. AI drafts a structured article: date, ticket ref, client, problem,
     root cause, solution, verification, tags — article template
     configurable in instance settings
  3. Agent reviews/edits the draft -> confirms -> page created in the
     client's shelf via the BookStack API; the ticket gets a link back to
     the article
  4. No AI configured? Same button, **empty-template mode** — manual
     problem/solution entry, still lands in the right shelf
- **MCP tools:** `bookstack_search`, `bookstack_get_page`,
  `bookstack_create_page`, `bookstack_update_page` — an external AI agent
  over MCP runs the same summarize-and-log flow without the button (writes
  gated like other MCP write tools)
- **No built-in KB:** the former "knowledge base" feature is dropped in
  favor of this integration; the provider framework is generic enough that
  other KBs (Wiki.js, Outline, Notion) can become KB providers later

## 9. Deployment & networking (Portainer)

### Reverse-proxy strategy: BYO-first, no hard dependency

The app is proxy-agnostic by contract:

- **Single entry point:** the API container also serves the built SPA —
  one port (`api:3000`) to point any reverse proxy at
- **`PUBLIC_URL`** is the only place the public address is configured; all
  generated URLs (email links, portal, OIDC/SAML redirect URIs, webhooks,
  MCP) derive from it. No hard-coded hosts/ports in code or images
- **Proxy headers:** `X-Forwarded-For` / `-Proto` / `-Host` honored only when
  `TRUST_PROXY` is set (default: trust the compose network); cookie Secure
  flag follows the forwarded proto, so TLS termination can live anywhere

Two deploy modes, same app code (two self-contained compose files, so a
single file always suffices — Portainer CE deploys one file per stack):

- **Mode A — BYO proxy (default):** `deploy/docker-compose.yml` exposes no
  public ports. Docs ship copy-paste configs for Caddy, Traefik, and nginx
  plus a generic "point your proxy at `api:3000`" recipe
- **Mode B — bundled proxy:** `deploy/docker-compose.proxy.yml` adds a Caddy
  container with automatic HTTPS (Let's Encrypt, HTTP-01 or DNS-01) in front
  of the app — one-command deploy for hosts without a proxy. Traefik-based
  hosts stay on Mode A with the documented label recipe; nothing app-side
  changes

### Compose layout

- Services: db (Postgres 16), redis (7), api (SPA + API), worker
  (+ caddy in `docker-compose.proxy.yml`; + mailpit/adminer with `dev`
  profile in both files)
- All config via `.env` (documented in `deploy/.env.example`); named volumes
  for db + attachment storage; healthchecks; restart policies; non-root
  images
- Portainer: import either file as a stack (web editor / upload / Git repo);
  a custom stack template from the Git repo gives one-click create per
  instance; both proxy modes importable
- Migrations auto-run on api boot; backup = `pg_dump` cron + volume snapshot
- Later: Helm chart for k8s users (out of scope for v1)

## 10. Security baseline

- TOTP MFA for agents/admins; SSO (OIDC + SAML) in Phase 3 with the
  people-mapping wizard (§7b); enforced SSO must always retain a local MFA
  break-glass admin
- Encrypted-at-rest email, SSO client, and integration credentials (instance settings)
- HMAC-signed outbound webhooks; verified inbound; rate limiting; audit log
- Magic-link tokens: single-use, short-lived, rate-limited, enumeration-safe;
  unavailable for SSO auth-source users
- Dependency audit in CI; pinned images with digests for release tags
- Client isolation enforced at query layer (see AGENTS.md rules)

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Email threading edge cases (mis-routed replies) | Conservative matching order, "no match -> new ticket", reassign API, fixture tests |
| Scope creep | Phases with exit criteria; CMDB/reports deliberately Phase 3 |
| Instance sprawl if we ever host many MSPs | Deploy unit = one compose stack per instance (Portainer stacks), zero shared state between instances |
| Email deliverability complaints | SPF/DKIM setup guide, per-instance sending domain |
| SSO misconfiguration locking staff out | Hybrid mode default; enforced mode requires a retained local MFA break-glass admin; mapping wizard needs explicit confirmation before any conversion |
| 100MB+ uploads behind Cloudflare/proxies; M365 dropped basic-auth SMTP | Chunked (tus) upload pipeline keeps every HTTP body small; outbound mail via provider abstraction with M365 OAuth2 workflow; CI upload test at 150MB |
| Reverse-proxy misconfig (broken links/OIDC redirects) | Single PUBLIC_URL source for all generated URLs; proxy-mode smoke test in CI/docs (email link + OIDC redirect checked) |
| Open-source maintenance burden | Small surface (TS monorepo), clear contribution guide, DCO |

## 12. Decisions needed from you

1. **Name** — settled: **Kipple**
2. **License** — MIT (permissive) vs Apache-2.0 (patent grant)?
3. **Portal addressing** — subdomain per client (needs wildcard DNS) vs path-based (`/p/{client}`)? Subdomains look better; path is easier to self-host.
4. **UniFi Talk version** — which version(s) must the integration target?
5. **osTickets data export** — can you share a schema dump / sample CSV of your data (sanitized) so the importer is built against real shapes?
6. **Hosting** — single Portainer host confirmed? Any second region/DR requirement?
7. **Billing** — Invoice Ninja direction confirmed (§8b). Rate card: per
   client, per agent, or per service — which matches how you invoice today?
8. **SSO** — confirm the preset list (Entra, Google Workspace, Zoho Directory,
   Okta, OneLogin, Duo, Huntress ITDR, Keycloak); which IdP does *your*
   environment use so we test against it first? Any missing IdP we should add?
9. **BookStack** — what version is your instance running, and should the
   per-client link target a shelf or a book (or both, shelf default)?
10. **Ticket aliases** — settled: plus-addressing
    `support+{ticket}@yourdomain.com`; no subdomains or catch-alls

## 13. Extra ideas (backlog, not committed)

**High value for MSPs**
- **Assets/CMDB-lite** (Phase 3) — MSPs live on "which device, which client, which tech"; tickets auto-link to asset
- **Password reset request form** — the #1 MSP ticket type; template with auto-reply + internal checklist
- **Billable time -> invoicing**: Invoice Ninja provider (draft invoices, §8b)
  so time tracking feeds billing; CSV fallback; QuickBooks/Xero later
- **Round-robin/auto-assignment** by skill tags + working hours; vacation mode
- **SLA escalation** (nudge assignee -> reassign -> notify admin)
- **Call logging from UniFi Talk** attached to tickets (pairs with contact sync)

**Differentiators**
- **MCP as a first-class citizen** — market it: "your help desk that AI agents can operate"; read-only MCP by default, opt-in writes
- **OpenAPI + MCP from one Zod source of truth** — API and MCP never drift
- **Per-client branding** — client sees *their* logo/brand, not just the MSP's (great for MSPs serving white-label sub-MSPs)
- **Status page per client** (incident mode: broadcast to portal banner + email)
- **AI assist (optional, BYO-key)**: summarize long threads, draft reply, suggest resolution — runs through the same MCP surface, so any model works; no data leaves unless the user connects a provider. Flagship use case: "Summarize & log to BookStack" (§8e)

**Workflow & collaboration (scope pass, not committed)**
- @mentions + watchers + CC; canned responses & multi-action macros
- Parent/child tickets + ticket cloning; saved queue views per agent;
  batch operations (bulk reassign/tag/close); snooze / remind-me
- Repeat-ticket detection (same client + issue reopened within X days)
- Quick call log -> time entry (manual, plus Talk call logs)
- Resolution-cause taxonomy -> "top causes per client" (QBR material)
- Expiry tracking (SSL certs, domains, licenses) -> warning tickets
- Maintenance windows + client announcement + monitoring-alert suppression
- On-call rotation + escalate-to-on-call; PTO calendar (feeds auto-assign
  and SLA business hours)
- Multi-location clients; contact roles (billing / technical / executive)
- Client offboarding workflow (archive, export, retention)
- Per-client account notes ("prefers email replies", "240V building")

**Nerd touches (scope pass, not committed)**
- "Similar tickets" suggestions (FTS/embeddings) + linked BookStack article
- Log-file viewer (monospace, line numbers) for .log/.txt attachments
- Credential/PII auto-masking in public updates
- API/MCP usage analytics per key/tool
- Voicemail transcription (Talk) attached to tickets
- Secure client document exchange (per-client data room)
- Remote-support handoff links (RustDesk/AnyDesk/ScreenConnect) with
  session time auto-tracked — complements the RMM deep links

**Platform**
- CLI (`kipple`) for ops: create client/ticket, import, tail webhooks
- Backup/restore runbook + `kipple backup now` cron target
- i18n-ready strings from day one (cheap now, painful later)
- PWA for agent use on phones; mobile-responsive portal
- SCIM 2.0 auto-provisioning/deprovisioning (Entra, Okta, OneLogin, Zoho) on
  top of the Phase 3 SSO base (§7b); magic-link login option for clients
- Plugin/extension hooks in Phase 4+ (providers, portal widgets) — keep core closed until the framework is proven
- Demo/sandbox seed data in every deployment ("try it" button)
- Telemetry (opt-out, anonymous) to track adoption & breakage

**Integrations queue after UniFi Talk**
UniFi Network (devices/assets), pfSense/opnsense, Watcher, NMS, Veeam/backup agents, Windows (PSRemoting for the password-reset flow), Google/Microsoft Calendar (block time while tracking), Slack/Teams interactive bots (per-ticket threads, reactions), Matrix.
