# STATUS

Rolling build state for Kipple. **Every work session must read this first and
update it (plan table + recent sessions) before committing**, so any other
chat or contributor can pick up where work left off. Deep design lives in
`docs/PLAN.md`; conventions in `AGENTS.md`.

## Current phase

**Phase 1 — Core ticketing.** Phase 0 (foundation) is complete.
Email outbound (§5b), email inbound, the client portal with magic-link
login, time tracking v1, the SLA feature (backend + workspace UI), and
item 11 (email templates + rules, notification center, dashboard stats +
presence) are live end-to-end.
All 13 items in the plan table below are shipped — including per-client
branding for the portal (item 12) and attachments on updates v1 (item 13:
local-disk storage, multipart uploads capped at ATTACHMENT_MAX_MB per
file). The remaining Phase 1 scope from PLAN.md
(chunked/tus uploads + S3 backend, hold states, staff client
restriction, agent invites, client self-registration) is tracked as
backlog rows 14–18; after those, Phase 2 (API + MCP + integrations) is
next. Update composers (workspace + portal) are now a rich text editor
(TipTap): headings, lists, code, quotes, links, image embeds by URL, font
size — sanitized HTML in the web timeline, plain-text email egress.

## What's live

- Monorepo (pnpm + Turborepo); CI (lint/typecheck/test + dependency audit) +
  GHCR image builds on push
  (`ghcr.io/kulik-labs-development/kipple/{api,worker,mcp}`, public → anonymous pull);
   `deploy/docker-compose.yml` (BYO proxy) / `deploy/docker-compose.proxy.yml`
   (bundled Caddy) deploy via CLI or as a Portainer CE/BE stack (needs
   `AUTH_SECRET` + `PUBLIC_URL`; optional `KIPPLE_TAG`, `TRUST_PROXY`,
   `COMPOSE_PROFILES=dev`) — full guide in `docs/DEPLOYMENT.md`
- Postgres schema (Drizzle, migrations auto-run on api boot): users, sessions,
  accounts, verification, twoFactor, clients, contacts, contact_clients, tickets,
  updates, settings, email_outbox, email_messages, time_entries, sla_policies,
  email_templates, rules, rule_runs, notifications
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
 - Email inbound (§5.1): worker IMAP IDLE loop (imapflow 1.7.6,
    `mailboxOpen`/`fetchAll`/`idle`/`exists` events) with catch-up scan of
    unread (capped 100) + live `exists` pickup + reconnect backoff 5s→5min;
    parsing in `packages/mail` (mailparser,
   canonical Message-IDs) with fixture `.eml` tests; `email_messages` table
   (`message_id` unique = idempotency key); match order alias → `[KIP-n]`
   subject tag → References/In-Reply-To (inbound ∪ outbox ∪
   `updates.email_meta.messageId`) → known contact creates a ticket on the
   primary client; unknown sender logged, no ticket; inbound updates are
   public, authored by the contact's portal user, `email_meta.messageId`
   stamped; mail stays unseen (readOnly) so rescans are safe; `GET/POST
   /api/imap` + test-connection (password encrypted at rest)
 - Magic-link login + client portal (plan item 8): better-auth `magicLink`
   plugin (hashed single-use tokens, 10 min expiry, 5/10min rate limit,
   sign-up disabled) wired to our outbox via a `sendMagicLink` hook that only
   emails LOCAL CONTACT accounts (unknown emails, SSO users, and staff get
   nothing; the request response is identical either way — no enumeration);
   verify redirects to `/portal` with a signed session cookie; public
   `POST /api/auth/sign-up/email` intercepted at 403 once the instance has
   users (the block moved out of a better-auth hook so server-side
   provisioning can create users); `POST /api/contacts/:id/portal` lets staff
   provision (idempotent) a contact's portal account (random credential
   password — magic link is the only door); `/api/me` returns
   `primaryClient` for contacts; web: login view with client (magic link) /
   agent (password) tabs, new PortalView (request list with status chips +
   search, thread view, reply, new-request modal, 30s polling), role-based
   routing in App (contact → portal, staff → workspace)
 - Time tracking v1 (plan item 9): `time_entries` table (migration 0005;
  running timer = `duration_s IS NULL`, one per agent; `client_id`
  denormalized for billing reports). API: `POST /api/time/start` (409 if a
  timer is already running), `POST /api/time/stop` (min 1s),
  `POST /api/time/entries` (manual: startedAt + durationS 1s–24h),
  `GET /api/time` (filters ticketId/clientId/agentId/billable/running/
  completed/from/to; client-scoped — contacts see only their clients),
  `GET /api/time/active`, `PATCH/DELETE /api/time/:id`; audit rows on every
  action. Web: TimePanel in the ticket detail (totals + billable totals,
  start/stop with live tick, entry list with billable toggles + delete,
  manual-entry form), active-timer chip in the workspace header, `T`
  shortcut toggles the timer for the selected ticket
  - SLA feature backend (plan item 10): enable-able, OFF by default
    (`settings` key `sla`). `sla_policies` (migration 0006): named policies
    with per-priority response/resolve targets in business minutes; exactly
    one instance default. Precedence per ticket: ticket override
    (`tickets.sla_policy_id`, PATCH-able) > client policy
    (`clients.sla_policy_id`) > instance default; the resolved id is recorded
    on the ticket so due times survive policy edits/deletes. Business hours
    are an IANA timezone + per-day windows (`settings` key `business_hours`,
    default Mon–Fri 09:00–17:00 UTC); all math is minute-stepped in
    `@kipple/shared` (`addBusinessMinutes`/`businessMinutesBetween`, exact
    across DST, 12 unit tests). Due times = `sla_response_due_at` /
    `sla_resolve_due_at` computed from ticket creation (or re-creation on
    priority/policy change); states `pending | at_risk | breached | met`
    (at risk = ≥75% of the business time elapsed). Events fire once each via
    the state machine: a staff first reply (or close) settles response/
    resolve met-or-breached immediately; a BullMQ `sla` queue repeatable
    `sla-tick` job (worker, 60s) walks open tickets for at-risk/breach
    transitions. Every event writes a `system` update (visible in the
    timeline) + an audit row (`sla.response.at_risk` etc.). API:
    `GET /api/sla/config` (staff), `POST /api/sla/settings` +
    `POST /api/sla/business-hours` (superuser), `GET/POST /api/sla/policies`
    + `PATCH/DELETE /api/sla/policies/:id` (list/read staff, writes
     superuser; duplicate name = 409). SLA fields are stripped from ticket
     responses for contact users (no portal leakage). 9 new api e2e tests.
     Web display (countdowns, badges, policy manager) = next step
- Item 11 (plan item 11): **email templates** — `email_templates`
   (migration 0007); 4 defaults (ticket_new, ticket_reply, ticket_close,
   csat) seeded at first-run setup, ALL disabled — nothing auto-sends.
   `{{dotted.path}}` rendering (unknown vars → empty). API:
   `GET /api/email/templates` (staff), `POST/PATCH/DELETE`
   `/api/email/templates[/:key]` (superuser; dup key = 409),
   `POST /api/email/templates/preview` (staff — render against a real
   ticket). **Rules engine** — `rules` + `rule_runs` (every execution
   logged). Match: event (ticket.created / ticket.status_changed /
   ticket.reply / ticket.updated) + status/fromStatus/priority/clientId/
   tags (all must match)/staffOnly. Action (one per rule):
   send_template (rendered → outbox via the provider queue) | assign |
   add_tag | set_status (close also settles SLA) | webhook (HMAC-SHA256
   `x-kipple-signature` when a secret is set, 10s timeout). Disabled until
   enabled. Events fire from the ticket routes after the main writes;
   create/patch responses re-read the row so rule mutations are visible.
   `POST /api/rules/test` = dry-run "what would fire" preview (never
   executes). `GET /api/rules/runs` = execution log. **Notification
   center** — `notifications`; fan-out to the ticket's assignee (never the
   actor): assigned (create/reassignment), staff reply, status change, and
   SLA breach (via `emitSlaEvent`). API: `GET /api/notifications[?unread]`,
   `GET /api/notifications/count`, `POST /api/notifications/read`
   (self-scoped). **Presence** — `PATCH /api/me/presence`
   (online/away/busy/offline, self-only; column pre-existed). **Web** —
   `NotificationBell` (30s poll, unread badge, dropdown, mark-all-read,
   click-through marks the item read and opens the ticket),
   `AutomationManager` (superuser modal, two tabs): templates tab
   (list/enable/edit with `{{var}}` hints, rendered preview against the
   selected ticket, create/delete) and rules tab (list with match/action
   summaries + on/off, editor for event/conditions/action, "test — what
   would fire" dry-run panel driven by `POST /api/rules/test`); header
   presence picker; dashboard stats gain an **overdue** tile (active
   tickets on a breached SLA line, danger colored) + a 14-day
   opened/closed bar strip (`dailySeries` + `Sparkline`). 10 new api e2e
   tests + 2 new web unit tests.
- Per-client branding (plan item 12): `clients.branding` (jsonb, column
  has existed since migration 0000) is now `{ themeId?, accent?, logoUrl? }`
  validated by `ClientBranding` in `@kipple/shared` (themeId must be a
  portal-surface theme from the THEMES registry, accent = hex color,
  logoUrl = URL). `POST/PATCH /api/clients` accept it (`{}`/`null` store
  as null; duplicate rules unchanged); `GET /api/me` returns the contact's
  OWN primary client's branding (never another client's — scoping test
  included). Web: portal theme precedence = user preference > client
  branding.themeId > instance theme; branding.accent overrides the
  `--color-accent` token for the portal only (staff workspace untouched);
  PortalView renders the client logo in the header (+ browser favicon and
  document title) with a broken-image fallback. `ClientManager` workspace
  modal (superuser/admin, "clients" header button): client list + create,
  branding editor (theme picker limited to portal themes, accent with
  color picker, logo URL with live preview), save/clear. 9 new api e2e
  tests + 5 new web unit tests.
- Attachments on updates (plan item 13, v1): `attachments` table
  (migration 0008, cascade-deletes with the update) + local-disk storage
  under `STORAGE_DIR` (default `/app/storage` in the api image, backed by
  the `storage-data` named volume in both compose files; per-file cap
  `ATTACHMENT_MAX_MB`, default 25MB). Uploads = `POST
  /api/tickets/:id/updates` in multipart mode (fields kind/body + 1–10
  files; JSON body-only mode unchanged; overflow = 413 `file_too_large`
  with partial files cleaned up); download `GET /api/attachments/:id`
  (session cookie; contacts only see public updates on their own
  clients' tickets — out-of-scope and internal files 404, no existence
  leaks; `content-disposition: attachment` with UTF-8 filename* +
  nosniff); staff-only `DELETE /api/attachments/:id` (row + file, audit
  row). Disk path = server-generated id under a 2-char shard — the client
  filename is display data only (traversal-safe by construction). Ticket
  detail returns `attachments[]` on each update; workspace + portal
  composers gain a file picker (chips with size, remove, send-with-or-
  without text) and both timelines render attachment chips. 11 new api
  e2e tests + 4 web unit tests. Follow-ups (backlog row 18): chunked/tus
  uploads, S3 adapter, editable MIME allowlist, superuser upload
  settings.
- Rich text editor for ticket updates (post-Phase-1 follow-up, 09-01): TipTap v3
  editor in the workspace + portal update composers (replaces the plain
  textarea). Toolbar: bold/italic/strikethrough/underline/inline code, h1-h3 +
  paragraph, font-size marks (fs-sm/base/lg/xl utility classes — rendered via CSS,
  never inline styles, so the sanitizer stays closed), bullet/numbered lists,
  blockquote, code block, links (autolink, `target=_blank`), image embeds by URL
  (v1 — inline file upload = follow-up; attachments stay on the chips), horizontal
  rule, clear formatting, undo/redo. Bodies store sanitized-friendly HTML; every
  render (workspace timeline + portal thread) runs `toRenderable()` — legacy plain
  text is escaped + line-broken, HTML is DOMPurify-sanitized (tag/attr allowlist,
  URI-scheme allowlist + attribute hook stripping data:/javascript:). Email egress
  strips HTML at the `enqueueOutbox` seam (shared `htmlToText`: blocks to newlines,
  tight lists kept tight, entities decoded) so the plain-text transport never
  carries tags. New files: `packages/shared/src/rich.ts` (+ `./rich` subpath export
  — keeps node-only shared code out of the web bundle), `apps/web/src/lib/rich.ts`,
  `apps/web/src/lib/fontSize.ts`, `apps/web/src/components/RichTextEditor.tsx`,
  rich-text CSS in `apps/web/src/index.css` (semantic tokens only). Tests: shared
  rich 6, web rich 8 (XSS cases, legacy pass-through, emptiness checks); gates
  4/4 tasks green.

## Phase 1 — active plan

| # | Item | Status |
|---|------|--------|
| 1 | Ticket domain API: clients, contacts (M2M with primary client), tickets (number + alias), updates (public/internal) | done |
| 2 | Client scoping in query layer + mandatory client-scoping tests (contact users only ever see their own client's data) | done |
| 3 | Audit log on all mutations | done |
| 4 | `users.contact_id` link so portal users map to contact records | done |
| 5 | Email outbound: provider queue (§5b) — generic SMTP first, then M365 OAuth2 (adoption gate) | done (SMTP; M365/Google = Phase 2) |
| 6 | Email inbound: worker IMAP IDLE (imapflow) + mailparser, Message-ID dedupe, thread matching (References → alias → subject tag → contact), no match → new ticket | done |
| 7 | Agent workspace UI: queue, ticket detail with update timeline, reply, status/priority/assign/tags | done (SLA timers arrive with item 10) |
| 8 | Client portal + magic-link login for contacts (portal users hard-scoped to their clients) | done |
| 9 | Time tracking v1 (billable/non-billable per ticket/agent/client) | done |
| 10 | SLA feature (enable-able, OFF by default; per-client/per-ticket policy precedence) | done |
| 11 | Email templates + rules v1 (nothing auto-sends by default), notification center, dashboard stats + presence | done |
| 12 | Per-client branding override for portal theme (uses `clients.branding`) | done |
| 13 | Attachments on updates v1 (multipart uploads, local disk, client-scoped) | done (v1 — chunked/S3 = row 18) |
| 14 | Hold states "waiting on client/vendor" + hold timers, auto-close with pre-close warning (template + rule) | backlog |
| 15 | Staff per-client access restriction (query-layer scoping, unrestricted by default) | backlog |
| 16 | Agent signups: admin-invited via email token link, MFA on first login | backlog |
| 17 | Optional client self-registration, gated by per-client allowed email domains (off by default) | backlog |
| 18 | Attachments v2: chunked (tus) uploads + S3 adapter + editable MIME allowlist + superuser upload settings (PLAN §6b) | backlog |

## Recent sessions

- **2026-09-02 (iconography — Phosphor, light weight — issue #7)** — Web icon pass on
  the locked spec: @phosphor-icons/web v2.1.2 (MIT; a ligature-font system — per-weight
  CSS, Vite bundles the woff2 so the app stays self-hosted, no CDN) + a thin
  `PhosphorIcon` wrapper (light = default weight, `filled` = fill-weight state toggle,
  a11y label passthrough). Slots: notification bell icon-only with the required
  filled=unread / outline=cleared mapping off the poll count, queue search field, +new,
  queue-row created date, ticket detail opened stamp, paperclip on every attachment chip
  (workspace + portal timelines and composer chips), composer attach/send buttons, and
  Link/Image in the rich-text toolbar (title tooltips already existed). Motion is
  whole-icon CSS only, zero custom/split assets: bell arrival wiggle (one-shot keyframe,
  top-anchored, re-armed on animationend), gear hover-turn, users hover-bob, paperclip
  hover tint. Filter chips, stat cards and SLA chips deliberately stay text-only.

- **2026-09-02 (agent-notes visibility + ticket created date — PR #5)** — Two
  asks from #kipple-work: staff-only internal notes in-line with the other
  replies (one chronological thread), and the ticket created date visible on
  each ticket. Recon: the internal-notes backend already ships on main
  (08-30 session) — `updates.kind` public/internal/system, contacts forced
  public on both the JSON + multipart update paths, `loadTicket` filters
  kind=public for contacts at the query layer, attachment download 404s
  internal files, `queueTicketReply` skips internal (never emailed), and the
  `update.create` audit row carries kind. It was just invisible until the
  deploy fix (PR #1) made the stack reachable. This PR adds, all in
  `@kipple/web` (no schema change, no migration): (1) the workspace timeline
  renders an internal update as a distinct card — warn border/background + an
  `INTERNAL NOTE` badge — so staff-to-staff notes are recognizable inside the
  one chronological thread (public + internal interleaved by createdAt,
  unchanged); (2) the queue list rows show the ticket created date
  (`shortDate` = MM-DD local) beside the relative updated time, with a full
  `opened <stamp>` tooltip — the ticket detail + portal headers already
  showed `opened <stamp>`. Web test: `shortDate` (1). Verified live on the
  merged PR #4 stack: an internal note interleaves in the workspace timeline,
  the portal (contact) API returns public-only and the rendered thread omits
  the note, an internal note enqueues no outbox row, and the audit row
  records kind=internal. Gates green (lint/typecheck/test/build; web 36
  tests).

- **2026-09-01 (rich text editor — workspace + portal composers)** — TipTap v3 editor
  for ticket updates (request from #kipple-work: the plain textarea was too plain
  — image embeds, font control, full formatting). See the "Rich text editor" bullet
  in What's live for the full shape. Storage stays `updates.body` (now
  sanitized-friendly HTML); no new table, no migration. Sanitizer = DOMPurify
  allowlist + URI-scheme allowlist + attribute hook (data:/javascript: stripped)
  — stored bodies are re-sanitized on every render, legacy plain text keeps
  rendering via the escape path. Email egress: `enqueueOutbox` now strips HTML to
  plain text (shared `htmlToText`) so the SMTP transport never carries markup.
  Images v1 = URL embeds (absolute app paths work for existing attachments); inline
  upload endpoint = follow-up. Deps added to @kipple/web: @tiptap/{react,starter-kit,
  core,extension-image,extension-placeholder}, dompurify, jsdom (dev) — link +
  underline are configured through StarterKit v3 (which bundles them; importing
  the extensions separately double-registered and threw duplicate-extension
  warnings). Editor CSS targets `.tiptap.rich-editor-area` (the editor root is
  one node carrying both classes — a descendant selector never matched, so list/
  paragraph/code styling was silently dropped in the editor while the rendered
  `.rich-text` body was fine). Gates: lint/typecheck/test/build green (195 tests).
  Screenshots + PR follow in #kipple-work.
- **2026-09-01 (docs audit pass + merge records — this fix)** — Post-merge audit of README/AGENTS/PLAN/STATUS against the code + commit history (triggered from #kipple-work after PR #2). Findings + fixes: README was stale on attachments v1 (roadmap row + Status section still listed it as remaining — shipped as item 13, merged 1a1b36b 06:56 CDT; plus the apps/mcp Phase 2 marker in "The stack") · AGENTS.md "12-item plan table" wording predates the item-13 row (the table is now 18 rows: 13 done + 14–18 backlog) + the layout line named a nonexistent docs "API reference" · PLAN §4 data model had `audit_logs` (actual table = `audit`) and no phase markers on the unbuilt tables (api_keys/webhooks/integrations/sync_logs = Phase 2; notification_streams/notification_log = Phase 3). This pass also records the docker-deploy fix session (bullet below), which never made it into this file, and both 09-01 merges: PR #1 (docker deploy, 8871703) merged 02:00 CDT (bdbcf1a); PR #2 (attachments, 3d9b563) merged 06:56 CDT (1a1b36b). Docs only, no code changes.
- **2026-09-01 (docker deploy fix — PR #1, merged 02:00 CDT, bdbcf1a)** — "Won't launch" from a fresh clone, three root causes: (1) Mode A compose (BYO proxy) published no ports — stack came up but was unreachable outside the compose network → `API_PORT` published (`${API_PORT:-3000}:3000`) + `.env.example` entry; (2) the api image shipped without the Drizzle migrations — zero tables on first boot, setup wizard 500 → COPY `apps/api/drizzle` into the image; (3) the worker healthcheck ran `ps -p 1` on BusyBox alpine (no procps) → `grep -q node /proc/1/comm`. Verified from scratch: 4 containers healthy, /healthz 200 from host, 13 tables migrated, full UI pass (wizard → client → ticket #1). Committed 8871703 (branch fix/docker-launch), merged 02:00 CDT (bdbcf1a).
- **2026-09-01 (item 13 — attachments on updates, v1, done)** — First
  backlog row of Phase 1. `attachments` table (migration 0008,
  cascade-deletes with the update) + local-disk storage under
  `STORAGE_DIR` (default `/app/storage` in the api image, backed by the
  new `storage-data` named volume in both compose files; per-file cap
  `ATTACHMENT_MAX_MB`, default 25MB). `POST /api/tickets/:id/updates` is
  now dual-mode: multipart (fields kind/body + 1–10 files, at least one
  file required; contact uploads forced public) or the original JSON
  body-only (unchanged). Files stream to disk with a byte counter —
  overflow = 413 `file_too_large`, and the update row + attachment rows
  commit in one transaction with partial files cleaned up on any
  failure. Download `GET /api/attachments/:id` (session cookie; contact
  visibility = public updates on their own clients' tickets,
  out-of-scope/internal 404; attachment disposition with UTF-8 filename*
  + nosniff); staff `DELETE` removes row + file and audit-logs
  (`attachment.delete`). Disk path = server-generated id under a 2-char
  shard; the client filename is display data only (traversal-safe by
  construction — tested). Web: `api.uploadUpdate` (FormData, the
  JSON content-type skipped so fetch sets the multipart boundary),
  `formatFileSize` helper, file picker + removable chips in both
  composers (workspace TicketDetail + portal reply box; send enabled
  with files even when the text is empty), attachment chips in both
  timelines. Deploy: `api.Dockerfile` creates /app/storage owned by the
  kipple user (the named volume inherits it); both compose files add the
  env + `storage-data` volume (and the proxy file's worker healthcheck
  got synced to the Mode A BusyBox fix: `grep -q node /proc/1/comm`);
  `.env.example` documents both vars; DEPLOYMENT.md notes storage-data
  goes in the backup. 11 new api e2e tests (upload/list/disk, byte-equal
  download + headers, contact scoping incl. internal 404 + cross-client
  404, staff delete + audit, contact 403, 413 + no orphan files,
  traversal filename, >10 files, JSON path) + 4 web unit tests; full
  gate green.
- **2026-09-01 (deploy folder + no-proxy compose)** — Renamed `infra/` →
  `deploy/` and moved `.env.example` into it (everything deployment-related
  in one folder; a Portainer user grabs one folder). Split the reverse proxy
  out of a compose profile into a second self-contained file:
  `deploy/docker-compose.yml` (Mode A — BYO proxy, no proxy container, no
  published ports) and `deploy/docker-compose.proxy.yml` (Mode B — same core
  + bundled Caddy with auto-HTTPS, Caddyfile inlined in the `CADDYFILE` env
  var since Portainer CE cannot resolve relative bind mounts). Self-contained
  on purpose: Portainer CE deploys a single file per stack, so keep the core
  services in sync across both files (noted in both file headers + AGENTS.md).
  The only remaining compose profile is `dev` (mailpit/adminer).
- **2026-09-01 (docs accuracy pass, no code changes)** — Reviewed the
  item-12 code against the docs: `normalizeBranding`/
  `brandingValidationError` in `apps/api/src/routes/clients.ts`,
  `ClientBranding` + `portalThemes()` in `packages/shared/src/themes.ts`,
  and `resolveThemeChoice` precedence in `apps/web/src/lib/theme.ts` all
  match what STATUS/AGENTS/README claim. Verified claims against code:
  `apps/mcp` is still a 54-line scaffold, there is no OpenAPI/Swagger
  layer yet, and no `api_keys`/`webhooks` tables — so the README's
  "What it does" table overclaimed. Trimmed it to mark M365/Google mail
  providers, OpenAPI 3.1 + webhooks + scoped API keys, the MCP server,
  CSV/Invoice Ninja time export, SSO, chat-channel notification streams,
  and all integrations as Phase 2/3 (and dropped "command palette", which
  is not built). Roadmap row now says backlog (not "finishing") for the
  remaining Phase 1 scope. Also since the last bullet: README header
  switched to the new white wordmark with baked-in drop shadow
  (`logos/logo-wordmark-white-shadow.png`, `d6c64b0`) so it reads on
  GitHub's light background, and local `.opencode/` agent config is
  gitignored (`50b3510`).
- **2026-08-31 (item 12 — per-client portal branding, done)** — Last of
  the 12-item Phase 1 plan table. `clients.branding` (existing jsonb
  column) is now `{ themeId?, accent?, logoUrl? }` via a new
  `ClientBranding` schema in `@kipple/shared` (+ `portalThemes()`/
  `isPortalTheme()` helpers and a new `@kipple/shared/themes` subpath
  export so the browser bundle never loads the node:crypto index).
  Client create/patch validate `themeId` against the portal-surface
  themes and normalize `{}`/null; `/api/me` returns the contact's own
  primary client branding. Web: `resolveThemeChoice` takes branding
  (precedence: user pref > client branding > instance theme), accent
  overrides `--color-accent` portal-only, PortalView shows the client
  logo + favicon, and a new `ClientManager` modal (superuser/admin)
  edits theme/accent/logo per client and can create clients. 9 api e2e
  tests (incl. cross-client scoping), 5 web unit tests; full gate green
  (166 tests, build 4/4). Remaining Phase 1 PLAN.md scope tracked as
  backlog rows 13–17.
- **2026-08-31 (dep audit cleanup)** — `pnpm audit` was reporting 13
  findings, all in nodemailer (addressparser DoS, SMTP command injection,
  CRLF header injection, jsonTransport disableFileAccess bypass, OAuth2 TLS
  validation — collectively requiring ≥9.0.1), reachable two ways: our
  direct `^7.0.3` (SMTP provider) and transitively via
  `imapflow@1.0.200`'s pinned nodemailer 7.0.9. Bumped `@kipple/mail` to
  nodemailer `^9.1.0` and imapflow `^1.0.200 → ^1.7.6` (1.7.x dropped its
  nodemailer dependency entirely, so the vulnerable transitive copy is
  gone). Our usage is stable core API only — no code changes. Gate green:
  `pnpm audit` clean, lint, typecheck 7/7, 152 tests (incl. the live-IMAP
  ingest e2e and live-SMTP outbox e2e that exercise both libs), build 4/4.
  Pushed `774cbdb`.
- **2026-08-31 (Docker image build fix)** — All three `docker/*.Dockerfile`
  build stages copied only a subset of workspace `package.json` files before
  `pnpm install --frozen-lockfile`; pnpm links `workspace:^` deps only for
  members present at install time, so `@kipple/mail`/`@kipple/api` were
  unresolvable and esbuild failed ("Could not resolve mailparser"). Every
  build stage now copies all seven workspace manifests before install.
  Verified by stage simulation (web+api+worker+mcp all build); the GHCR
  image workflow now produces working images. Pushed `c568e00`.
- **2026-08-31 (item 11 web — done)** — Finished plan item 11.
  `NotificationBell` (30s poll, unread badge, mark-all-read, click →
  ticket + mark read). `AutomationManager` superuser modal with two
  tabs: templates (edit/enable/create/delete + rendered preview against
  the selected ticket) and rules (list + on/off, editor for event/
  match/action, "what would fire" dry-run via `/api/rules/test`).
  Header presence picker. Dashboard: `overdue` tile (breached SLA lines
  on active tickets) + 14-day opened/closed `Sparkline` strip
  (`dailySeries`). 2 new web unit tests; full gate green (152 tests).
- **2026-08-31 (item 11 backend)** — Email templates, rules engine,
  in-app notification center, presence API (all backend, no web UI yet).
  `email_templates`/`rules`/`rule_runs`/`notifications` (migration 0007).
  Templates: 4 defaults seeded at setup, all disabled; `{{dotted.path}}`
  rendering; preview endpoint renders against a real ticket. Rules:
  event match (created/status_changed/reply/updated + status/priority/
  client/tags/staffOnly) → one action (send_template/assign/add_tag/
  set_status/webhook-HMAC); fired from ticket routes, every run logged to
  `rule_runs`, `POST /api/rules/test` dry-run preview. Notifications fan
  out to the assignee only (never the actor): assigned/reply/status
  change + SLA breach (hooked into `emitSlaEvent`). Presence:
  `PATCH /api/me/presence`. Gotchas found: const-destructured row
  reassignment crashes the route (re-read after rule actions, return the
  fresh row); test `wipe()` must delete `slaPolicies` too (leftover
  defaults from earlier runs break later suites); outbox rows share
  `createdAt` ties — test by ticketId, not list position. 10 new e2e
  tests; full gate green (150 tests).
- **2026-08-31 (SLA workspace UI)** — Finished plan item 10. `lib/sla.ts`
  (web): `queueSlaState` (breached > at_risk > pending, closed = none),
  `slaRemainingMinutes` (business minutes left, clamped at 0),
  `formatRemainingMinutes` ("2d 4h"/"3h 20m"/"45m"/"due"), state
  class/label maps — 5 new unit tests. `api.ts`: SLA fields on
  `TicketRow` (the API strips them for contacts), `SlaPolicy`/`SlaConfig`
  types, endpoints `slaConfig`/`slaSetEnabled`/`slaSetBusinessHours`/
  `slaCreatePolicy`/`slaPatchPolicy`/`slaDeletePolicy`, `slaPolicyId` in
  patchTicket. TicketDetail: SLA strip under the staff controls —
  response + resolve chips (state, due stamp, remaining business minutes)
  and a per-ticket policy override select (inherited | each policy).
  QueuePane: compact `sla <state>` chip on rows with a due time.
  WorkspaceView: loads `/api/sla/config` (init + 30s poll), `sla` header
  button (enabled = ok-colored; only superusers open the manager), renders
  `SlaManager`. `SlaManager.tsx`: superuser modal — enable/disable,
  business-hours editor (IANA timezone + 7 per-day start/end time inputs,
  blank day = off, start<end checked client-side), policy list (default
  radio, targets summary `u 60/240 · h 120/480 · …`, delete with confirm),
  add-policy form (name + 8 numeric target inputs in a priority grid);
  every action refetches config + list + detail. Build fix: web now
  imports the math from `@kipple/shared/sla` (new subpath export) because
  the shared index re-exports `crypto.ts` (node:crypto) which rollup
  refuses for the browser bundle. Verified: lint/typecheck (7)/test (140,
  incl. 9 api + 5 web SLA tests)/build (4) green.
- **2026-08-31 (SLA backend)** — Built the backend half of plan item 10.
  Shared: `sla.ts` — `BusinessHours` (IANA tz + per-day windows, ISO days
  Mon=1..Sun=7; default Mon–Fri 09:00–17:00 UTC), `isBusinessMinute`,
  `businessMinutesBetween`, `addBusinessMinutes` — minute-stepped so DST
  shifts are exact; a whole minute counts when it overlaps the range by ≥30s
  (minute-aligned due times are exact, `now` rounds at the 30s mark);
  `SlaTargets` (per-priority response/resolve targets, 5 min–90 days).
  Schema (migration 0006): `sla_policies` (unique name, targets jsonb, one
  `is_default`), `clients.sla_policy_id`, tickets gain `sla_policy_id`,
  `sla_response_due_at`/`sla_resolve_due_at`, `sla_response_at`/
  `sla_resolved_at`, `sla_response_state`/`sla_resolve_state`. API
  `src/sla.ts`: settings load/save (`sla` + `business_hours` keys), policy
  CRUD (default demotion), `applySlaToTicket` (resolve precedence
  ticket > client > default, recompute from now; clears fields when off /
  no policy), `markTicketResponded` (first staff reply: met = instant
  event, late = state only so the tick announces the breach once),
  `markTicketResolved` (close: met/breached both emitted — a closed ticket
  leaves the tick scope), `tickSla` (open tickets: at risk at ≥75% elapsed,
  breach past due; each transition = one `system` update + audit row).
  Routes `routes/sla.ts`: `/api/sla/config`, `/api/sla/settings`,
  `/api/sla/business-hours`, `/api/sla/policies` CRUD (writes superuser-only,
  duplicate name 409 via `error.cause.code 23505`). Ticket routes: create
  applies SLA + staff body replies count as the first response; patch
  recomputes on priority or `slaPolicyId` change and settles resolve on
  close; both re-read the row so responses carry the fresh due times;
  contact responses strip all SLA fields. Worker: `sla` BullMQ queue with a
  60s `upsertJobScheduler` repeatable `tick` job. 9 new api e2e tests
  (off by default, CRUD + RBAC + business-hours validation, precedence,
  recompute, met-on-reply, deterministic past-date at-risk→breached tick,
  met-on-close, contact field hiding, disable). Verified: lint/typecheck/
  api tests (70)/shared tests (21) green; build pending with the web half.
  Next: SLA display in the workspace (detail countdown + queue badges) and a
  superuser policy/business-hours/enable modal.
- **2026-08-31 (time tracking v1)** — Built plan item 9. Schema:
  `time_entries` (migration 0005) — ticket/agent/client refs, `started_at`,
  nullable `duration_s` (NULL = running timer), `billable`, `note`;
  client id denormalized from the ticket at entry time. Service rules: one
  running timer per agent (checked in the route, 409 with the running entry
  on conflict — single-tenant low-concurrency model, no partial index),
  stop rounds to ≥1s, manual entries 1s–24h (zod in shared:
  TimeEntryStart/Manual/Update/View). API `routes/time.ts`: start/stop/
  entries/list/active/patch/delete; list accepts ticketId/clientId/agentId/
  billable/running/completed/from/to and is client-scoped (contacts see
  only their clients' entries, staff all); mutations are staff-only and
  ticket-scoped (out-of-scope = 404); every action audit-logged
  (time.start/stop/entry/update/delete). Web: `TimePanel` component in the
  ticket detail (ticket totals incl. billable, START TIMER / STOP · 00:05:12
  live tick, completed-entry list with per-row billable checkbox + delete,
  collapsible manual form: datetime-local + minutes + billable + note);
  active-timer chip in the workspace header (30s poll + 1s tick, click =
  stop); `T` keyboard shortcut toggles the timer on the selected ticket
  (via a ref to dodge the once-mounted keydown effect); `formatDuration` +
  `formatClock` helpers + tests. 6 new api e2e tests (start/409/active,
  stop/double-stop, manual + validation, scoping 404s, list filters +
  patch/delete + audit actions, contact list scoped to own client + 403 on
  mutations). Verified: lint/typecheck/test (114 tests)/build green.
  Follow-ups: CSV export (Phase 2, §8b), Invoice Ninja draft invoices
  (Phase 2), calendar blocking + call-log time entries (Phase 3), MCP
  start_timer/stop_timer tools (Phase 2).
- **2026-08-31 (client portal + magic link)** — Built plan item 8. Auth:
  better-auth's built-in `magicLink` plugin (found in the 1.7.2 dist — it has
  `sign-in/magic-link` + `magic-link/verify`, hashed tokens, single-use
  atomic consumption, built-in rate limit; it mints the session + signed
  cookie inside its own pipeline, so no hand-rolled cookies). Its one flaw —
  `sendMagicLink` fires for ANY email — is neutralized in our hook
  (`sendMagicLinkEmail` in `apps/api/src/mail.ts`): only existing local
  contact users get a link (outbox-queued, subject "Sign in to {instance}"),
  unknown/SSO/staff emails are silently skipped while the API still answers
  `{status:true}` (no enumeration, no spam, no account probing).
  `disableSignUp: true` + 600s expiry + 5/10min rate limit. The
  "signups closed after first user" rule moved from a better-auth
  databaseHook (which blocked ALL user creation) to an intercept in
  `auth-routes.ts` (403 on public `sign-up/email` once users exist) so
  staff can provision accounts server-side. New staff endpoint
  `POST /api/contacts/:id/portal` provisions a contact's portal user
  (idempotent; 409 if the email belongs to a different user; random
  credential password so email+password sign-in can't work — magic link is
  the only door). `/api/me` now returns `primaryClient` for contacts.
  Web: login view gained client/agent tabs (client = email → magic link,
  "check your inbox" state); new `PortalView` (request list with status
  chips + `/` search, thread view, reply box, new-request modal, 30s
  polling) and App routes by role (contact → portal, staff → workspace);
  `Field` supports `type="textarea"`; `filterPortalTickets` helper + 3
  tests. 8 new api e2e tests (provision idempotency, full
  send→verify→/api/me round trip, token single-use, unknown/staff/no-portal
  negative cases, sign-up block, contact-scoped list/create/reply-forced-
  public). Verified: lint/typecheck/test (106 tests)/build green.
  Follow-ups: no agent-UI for portal provisioning yet (endpoint is live +
  tested); staff magic-link opt-in (per PLAN: per-account flag + superuser
  policy) not implemented; domain-gated client self-registration (off by
  default) not implemented — contacts without a portal account get no link.
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
- **2026-08-31 (email inbound)** — Built plan item 6. `@kipple/mail`:
  `parseEmail`/`parseSimpleMail` (mailparser; Message-IDs normalized
  case-insensitive, brackets stripped), `extractThreadSignals` (alias in To,
  `[KIP-n]` subject tag, References/In-Reply-To set), `cleanEmailSubject`,
  IMAP helper (imapflow pinned `~1.0.200` — the 1.7 line renamed the API:
  `mailboxOpen`/`exists`/`fetch`, no `message` event); 5 fixture `.eml`
  files (alias reply, subject tag, references-only chain, unicode
  Q-encoding, unknown sender) + 30 tests. API: `email_messages` table
  (migration 0004, `message_id` unique = the idempotency key), `src/ingest.ts`
  — dedupe via onConflictDoNothing, match order alias → subject → thread
  (inbound message ids ∪ outbound `email_outbox.message_id` normalized in
  SQL ∪ `updates.email_meta->>'messageId'`) → known contact creates a ticket
  on the primary client (alias assigned, Re:/Fwd: stripped from subject);
  unknown sender = no ticket (logged as `unknown_sender`); contact without a
  client = `skipped_no_client`; every result audit-logged. Inbound updates
  are public, authored by the contact's portal user when one exists, and
  stamp `email_meta.messageId` so future threads match. Mail stays unseen
  (readOnly box) — rescans are safe because of the dedupe. `GET/POST /api/imap`
  + test-connection (password encrypted at rest like SMTP). Worker:
  `runIngestLoop` — connect → catch-up scan of unread (capped 100) →
  `exists`-event live pickup (prevCount+1..count) → IDLE (imapflow
  re-issues), exponential reconnect backoff 5s→5min, 30s poll when not
  configured. 8 new api e2e tests. Verified: lint/typecheck/test (95
  tests)/build green + worker bundle smoke (boots, both workers ready).
  Open follow-ups: no retry path for `unknown_sender` messages (add contact
  later, message stays logged); bounce handling (marks contact bounced)
  still needs inbound feedback; `email-ingest` BullMQ queue now only holds
  the scaffold placeholder (IMAP runs in-process in the worker).
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
