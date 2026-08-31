<p align="center">
  <img src="logos/logo-wordmark-black.png" alt="Kipple" width="440" />
</p>

<p align="center">
  <a href="https://img.shields.io/badge/status-phase%201%20%7C%20in%20progress-2ea44f?style=flat-square"><img src="https://img.shields.io/badge/status-phase%201%20%7C%20in%20progress-2ea44f?style=flat-square" alt="status" /></a>
  <a href="https://img.shields.io/badge/stack-TypeScript%20%7C%20Postgres%20%7C%20Docker-3178c6?style=flat-square"><img src="https://img.shields.io/badge/stack-TypeScript%20%7C%20Postgres%20%7C%20Docker-3178c6?style=flat-square" alt="stack" /></a>
  <a href="https://img.shields.io/badge/email-native%20by%20default-9c51b6?style=flat-square"><img src="https://img.shields.io/badge/email-native%20by%20default-9c51b6?style=flat-square" alt="email-native" /></a>
</p>

<p align="center">
  <strong>Open-source, self-hosted ticketing + client portal for MSPs.</strong><br/>
  Email-native conversations · REST + MCP API-first · white-label · one Docker Compose stack away
</p>

---

## What is Kipple?

Kipple is the help desk you run on **your** box for **your** clients.

One instance, your whole client base, your brand on everything. Clients open
and reply to tickets **over plain email** — no portal login required — while
your agents work tickets in a keyboard-first, console-style workspace with SLA
timers, time tracking that flows straight into invoicing, and an API surface
that AI agents can operate directly.

It exists to replace legacy PHP ticketing (hello, osTickets) with something
API-first, self-hostable, and unapologetically built for managed service
providers.

### Why the name?

*Kipple* is the term from the novel *The Joy of Shipping*: **neither trash
nor possessions — things that have future value.** A ticket in your queue is
exactly that: not done, not garbage, about to become useful. (The name is
settled. See §12 of the plan.)

## What it does

| | |
|---|---|
| **Email-native ticketing** | One support mailbox, plus-addressed ticket aliases (`support+1042@you.com`), IMAP IDLE ingest, smart thread matching, outbound providers for SMTP / Microsoft 365 OAuth2 / Google Workspace. No subdomains, no catch-alls, works as-is on M365 and Google. |
| **API-first** | OpenAPI 3.1 REST API generated from the same Zod schemas that validate requests — docs, validation, and MCP tools can never drift. HMAC-signed webhooks, scoped API keys. |
| **MCP server** | Your help desk that AI agents can operate: search, read, reply, track time — over stdio or HTTP. Read-only by default; writes are an explicit opt-in. |
| **White-label everything** | Themes are pure token swaps, per-client branding overrides, your logo on the portal and in every email. The agent app defaults to the "Console" theme: dark, monospace, command palette, LED status lights. |
| **Time tracking** | Start/stop timers per ticket, billable flags, per client/agent rollups, CSV export, and a draft-invoice pipeline into Invoice Ninja. |
| **SLAs you can switch on** | Named policies, business-hours aware, per-ticket → per-client → instance-default precedence, escalation-ready. Off until you need it. |
| **Auth that doesn't hurt** | Passwordless magic links for clients (no passwords to track), TOTP MFA for staff, OIDC + SAML SSO with one-screen presets (Entra, Google, Okta, Zoho, OneLogin, Duo, Huntress, Keycloak) and a people-mapping wizard that never re-points a user id. |
| **Notification streams** | One event pipeline, many channels: in-app, email, Slack / Teams / Discord / Mattermost / webhooks, web push — with per-stream filters, quiet hours, and digests. |
| **Integrations** | UniFi Talk contact sync, BookStack as your KB ("summarize & log" from a ticket), Tactical RMM deep links, monitoring alerts → tickets. |

## How the email story works

The hard part of ticketing, done properly:

```
 client hits "reply"                Kipple
 ┌──────────────────┐    IMAP IDLE   ┌───────────────────────────────────┐
 │ Gmail / Outlook  │ ─────────────▶ │ parse → dedupe (Message-ID)       │
 │ support+1042@…   │                │ → thread match (alias → subject   │
 └──────────────────┘                │   → contact) → one ticket, always │
      ▲                              └────────────────┬──────────────────┘
      │  threaded SMTP reply, agent as From,          │
      │  Reply-To back to the ticket alias            ▼
      └────────────────────────────────── agent workspace (console UI)
```

Internal notes never leave the system. No auto-responses are baked in —
every automated email is a template + rule *you* create. Nothing ships
enabled that wasn't asked for.

## Quick start

Production-style, on a single host (Postgres + Redis are the only external
services):

```sh
git clone <repo> && cd kipple
cp .env.example .env            # set PUBLIC_URL + mail creds
docker compose -f infra/docker-compose.yml up -d
# point any reverse proxy at api:3000 — or use the bundled Caddy:
docker compose -f infra/docker-compose.yml --profile proxy up -d
```

First visit runs the setup wizard (instance name → owner account).
Migrations run automatically on boot. Done.

Development:

```sh
pnpm install
docker compose -f infra/docker-compose.yml up -d db redis mailpit
pnpm dev                        # api + web + worker
```

## The stack

One language end-to-end — TypeScript strict everywhere, TypeScript nowhere
it doesn't belong.

```
 apps/api       Fastify 5 + Drizzle + Postgres 16 — REST v1, sessions, RBAC
 apps/worker    BullMQ on Redis — IMAP ingest, SLA ticks, webhooks, syncs
 apps/web       React 19 + Vite — agent workspace (Console theme) + client portal
 apps/mcp       MCP server (stdio + streamable HTTP) over scoped API keys
 packages/*     shared (Zod = source of truth) · ui (design tokens) · mail
```

## Rules we live by

- **Single-tenant by design.** One instance = one MSP = one database. No
  tenant column, no cross-MSP isolation layer. Scale to more MSPs by running
  more instances.
- **Client isolation is a query-layer rule**, not a UI trick. A contact can
  never surface another client's data — it's tested, not assumed.
- **No baked-in auto-replies.** All automated email is templates + rules,
  user-configured, off by default.
- **Stable identities.** SSO conversion only swaps the auth source; `users.id`
  never moves, so assignments and history survive.
- **Self-hosted to the bone.** Your uploads, your avatars, your secrets via
  env vars. Works fully offline behind any proxy.

## Roadmap

| Phase | What lands | Status |
|---|---|---|
| **0 — Foundations** | Monorepo, CI/CD + GHCR images, schema + auth (MFA, setup wizard, RBAC), setup/login/workspace screens | **done** |
| **1 — Core ticketing MVP** | Clients/contacts/tickets, email conversations, portal, SLAs, time tracking, themes, magic links, rules engine | **in progress** (11 of 12 items shipped) |
| **2 — API + MCP + integrations** | REST v1 (OpenAPI), webhooks, MCP server, M365 mail, UniFi Talk, BookStack, Tactical RMM | planned |
| **3 — Power features** | Assets, reports, SSO (OIDC/SAML), notification streams, CSAT, osTickets importer | planned |
| **4 — Productization** | License decision, docs site, demo instance, Helm — deliberately last | deferred |

Exit criteria for every phase live in [docs/PLAN.md](docs/PLAN.md).

## Status

**Phase 1 in progress — 11 of 12 plan items shipped.** Live today: the full
email ticket loop (IMAP IDLE ingest → thread matching → one ticket, threaded
SMTP replies, and zero automated emails unless you configure a rule), the
agent workspace (queue, ticket detail, reply/notes, status/priority/assign/
tags, live stats with sparklines, time tracking, SLA countdowns with a
superuser SLA manager), the client portal with passwordless magic-link
login, email templates + a rules engine with a "what would fire" dry-run,
the in-app notification center, and per-agent presence. Remaining Phase 1
item: per-client branding override for the portal theme.

Phase 0 (monorepo, CI/CD + GHCR images, schema + auth with TOTP MFA,
setup wizard, RBAC, theme system) is complete — see the rolling build state
in [docs/STATUS.md](docs/STATUS.md) for the full detail.

## More

- **Full plan & roadmap:** [docs/PLAN.md](docs/PLAN.md)
- **Contributing / agent instructions:** [AGENTS.md](AGENTS.md)
- **CI/CD:** `CI` runs lint + typecheck + tests on every push/PR; `Images`
  builds and pushes `ghcr.io/kulik-labs-development/kipple/{api,worker,mcp}`
  on `main` and `v*` tags — the Portainer stack pulls those.
