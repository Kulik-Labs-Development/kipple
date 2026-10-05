# Deployment

Single-host deployment: one Docker Compose stack, Postgres + Redis, one public
entry point (`api:3000` serves the API and the built SPA). The target host is
a Portainer-managed Docker node, but the same files work with the plain
`docker compose` CLI.

Two self-contained compose files in `deploy/` (one per reverse-proxy mode —
self-contained because Portainer CE deploys a single file per stack; keep the
core services in sync between the two):

| File | Reverse proxy | Use when |
|---|---|---|
| `deploy/docker-compose.yml` | none (BYO) | you already run Caddy/Traefik/nginx (default) |
| `deploy/docker-compose.proxy.yml` | bundled Caddy, auto-HTTPS | the host has no reverse proxy |

`deploy/.env.example` documents every env var; both files auto-load a
`deploy/.env` you copy from it.

Images (built by CI on every push to `main` and on `v*` tags):

| Image | Purpose |
|---|---|
| `ghcr.io/kulik-labs-development/kipple/api` | REST API + SPA (port 3000) |
| `ghcr.io/kulik-labs-development/kipple/worker` | Background jobs (email ingest, SLA ticks) |
| `ghcr.io/kulik-labs-development/kipple/mcp` | MCP server (stdio — see below) |

The repo is public, so the GHCR images pull anonymously. If the repo is ever
made private, add the GHCR registry in Portainer (or `docker login ghcr.io`
on the CLI host) with a PAT that has `read:packages`.

## Environment variables

All configuration is via env vars — there is no config file to mount.

| Var | Required | Default | Notes |
|---|---|---|---|
| `AUTH_SECRET` | yes | — | `openssl rand -base64 32`. The deploy fails fast if missing |
| `PUBLIC_URL` | recommended | `http://localhost:3000` | Single source for all generated URLs (email links, SSO redirects, webhooks). No trailing slash |
| `TRUST_PROXY` | no | `false` | `true` when a reverse proxy rewrites `X-Forwarded-*` (bundled Caddy: `true`) |
| `KIPPLE_TAG` | no | `latest` | Pin `vX.Y.Z` in production |
| `COMPOSE_PROFILES` | no | — | `dev` = mailpit + adminer (dev helpers only). One value or `*` — comma lists are a known Portainer bug. The proxy is a file choice, not a profile |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | no | `kipple` / `kipple` / `kipple` | Change the password in production |
| `DATABASE_URL` | no | `postgres://kipple:kipple@db:5432/kipple` | Point elsewhere only for an external Postgres |
| `REDIS_URL` | no | `redis://redis:6379` | |
| `STORAGE_DIR` | no | `/app/storage` | Where attachment files live inside the api container; backed by the `storage-data` named volume |
| `ATTACHMENT_MAX_MB` | no | `25` | Per-file upload cap (MB) for attachments on ticket updates |
| `KIPPLE_API_URL` | no (mcp) | `http://localhost:3000` | REST API base URL for the mcp container (on the stack network: http://api:3000) |
| `KIPPLE_API_KEY` | yes (mcp) | — | A Kipple API key (superuser "API & MCP" panel) — scopes the MCP server's reach |

## First run
| `ATTACHMENT_MAX_MB` | no | `25` | Per-file upload cap (MB) for attachments on ticket updates |

## Outbound mail — Microsoft 365 (Exchange Online)

Outbound mail (ticket updates, magic links, invites, test sends) is
configured in the web UI: **System → mail**. Microsoft 365 supports two
delivery modes:

- **Microsoft Graph** (default) — sends via the Graph `sendMail` API.
- **SMTP (OAuth2 bearer)** — sends via Exchange Online SMTP
  (`smtp-mail.outlook.com:587`) with an OAuth2 access token instead of a
  password.

### Entra app registration

1. [Microsoft Entra admin center](https://entra.microsoft.com) → **Identity
   → Applications → App registrations → New registration**. Any name (e.g.
   `kipple-outbound`); supported account types = your tenant only.
2. **Certificates & secrets → New client secret**: add a secret and **copy
   the value immediately** — it is only shown once. That value is the client
   secret Kipple stores encrypted at rest.
3. **API permissions → Add a permission → Microsoft Graph → Application
   permissions**: grant **`Mail.Send`**, then **Grant admin consent** for
   your tenant. This covers the Graph mode.
4. **SMTP mode only** — Exchange Online is a separate service principal, not
   Graph: **Add a permission → search “Exchange Online” → Application
   permissions**: grant **`SMTP.SendAsApp`**, then **Grant admin consent**
   again. Also enable OAuth2 SMTP authentication on the sender mailbox:

   ```powershell
   # Exchange Online PowerShell (or M365 admin center → Recipients → mailbox
   # → Email features → “Allow authenticated SMTP clients using OAuth”)
   Set-Mailbox -Identity helpdesk@example.com -SmtpAuthAcceptanceOAuth2 $true
   ```

### Where the ids live

- **Tenant (directory) ID** — Entra admin center → **Identity → Properties**,
  or the app registration’s Overview page (“Directory (tenant) ID”).
- **Client (application) ID** — app registration → **Overview**
  (“Application (client) ID”).

### Sender address

The sender is a real mailbox UPN (e.g. `helpdesk@example.com`) that the app
may send as. In the panel, set the provider to *microsoft 365*, paste the
tenant + client ids and the secret, set the sender and the delivery mode,
**save**, then **test connection** (Graph: fetches a token and probes the
sender; SMTP: performs the OAuth2 handshake), and a **test send** to a real
inbox. Inbound mail for the same address stays plain IMAP (IMAP settings,
unchanged).

## First run

Open `PUBLIC_URL` in a browser: the setup wizard creates the owner account
(which becomes the superuser) and sets the instance name. Signups stay closed
after the first user; agents are added by admin invitation later.

## Deploying

### docker compose CLI

```sh
git clone https://github.com/Kulik-Labs-Development/kipple.git
cd kipple/deploy
cp .env.example .env                    # then edit AUTH_SECRET, PUBLIC_URL, ...
docker compose up -d                    # Mode A (BYO proxy)
docker compose -f docker-compose.proxy.yml up -d   # Mode B (bundled Caddy)
docker compose --profile dev up -d      # + mailpit/adminer dev helpers
```

### Portainer (CE or BE)

Stacks, upload, and Git-repo sources all work; the compose file uses no
features that require Business Edition (no bind mounts, no `start_interval`).

1. **Stacks → Add stack**, name it `kipple` (or anything), then:
   - **Web editor** — paste `deploy/docker-compose.yml`
     (or `deploy/docker-compose.proxy.yml` for the bundled Caddy), or
   - **Upload** — send the file, or
   - **Git repository** — source for `Kulik-Labs-Development/kipple`, branch
     `main`, compose path `deploy/docker-compose.yml` (or
     `deploy/docker-compose.proxy.yml`). Git sources can enable **GitOps
     updates** (polling or webhook) with "re-pull image" for release-driven
     updates.
2. **Environment variables** (or *Load variables from .env file* — upload
   `deploy/.env.example` as a starting point):
   - `AUTH_SECRET` (required), `PUBLIC_URL`, and whatever else you're changing
     (`KIPPLE_TAG`, `TRUST_PROXY`, `POSTGRES_PASSWORD`, ...).
   - With `docker-compose.proxy.yml`: set `TRUST_PROXY=true`
     (defaults to true in that file, but set it explicitly).
3. Deploy. `depends_on ... service_healthy` is honored, so the API starts only
   once Postgres/Redis report healthy; DB migrations run automatically on API
   boot.

For repeat deployments, add a **custom template** (Templates → Custom →
Add, build method = Git repository pointing at the compose path above) so the
stack is one click per new instance.

**Portainer quirks to know**

- `COMPOSE_PROFILES` takes one profile name or `*`. Comma-separated lists are
  not activated (portainer/portainer#13033) — the only profile is `dev`.
- Variables set in the stack's environment can be edited later without
  editing the compose file (Portainer leaves `${VAR}` references in place).
- The API container exposes no host ports in Mode A; your reverse proxy must
  reach it via the stack network (below).

## Reverse proxy

The app is proxy-agnostic by contract: `PUBLIC_URL` is the only place the
public address is configured, and `TRUST_PROXY` switches on
`X-Forwarded-For/-Proto/-Host` handling. Two modes:

### Mode B — bundled Caddy (one-command deploys)

Deploy `deploy/docker-compose.proxy.yml` and set `TRUST_PROXY=true`. Caddy
gets automatic HTTPS (Let's Encrypt) once you point DNS at the host — replace
`:80` with your domain in the `CADDYFILE` env var of the `caddy` service
(edit the stack in Portainer, or the inlined copy in
`deploy/docker-compose.proxy.yml`). `deploy/Caddyfile` holds the same config
for reference.

### Mode A — your own reverse proxy

The compose exposes no public ports. Put your proxy on the stack network and
point it at `api:3000`:

```sh
# the stack's default network is kipple_default (stable: compose `name: kipple`)
docker network connect kipple_default <your-proxy-container>
```

- **Caddy** (on that network):
  ```
  help.example.com {
      reverse_proxy api:3000
  }
  ```
- **Traefik** (on that network, container labels):
  ```
  traefik.enable=true
  traefik.docker.network=kipple_default
  traefik.http.routers.kipple.rule=Host(`help.example.com`)
  traefik.http.routers.kipple.entrypoints=websecure
  traefik.http.routers.kipple.tls=true
  traefik.http.services.kipple.loadbalancer.server.port=3000
  ```
- **nginx** (anywhere): proxy to the API container's IP:3000
  (`docker inspect --format '{{.NetworkSettings.Networks.kipple_default.IPAddress}}' kipple-api-1`)
  — or join the network as above and use `api:3000`.

Set `TRUST_PROXY=true` and `PUBLIC_URL=https://help.example.com` either way.

## Webhooks

Two directions, one panel (superuser → system settings → **webhooks**):

- **Inbound** — monitoring tools POST alerts to Kipple; each alert becomes a
  ticket (or updates/closes the open one). Nothing is enabled until you turn
  a source on.
- **Outbound** — Kipple pushes signed JSON for house ticket events
  (`ticket.created`, `ticket.status_changed`, `ticket.reply`, `ticket.updated`,
  `ticket.hold_warning`) to URLs you register. Each hook gets a
  runtime-generated secret; every delivery is signed with an HMAC-SHA256
  `x-kipple-signature` header over the raw body (your receiver recomputes the
  digest and compares it). 4xx responses are permanent (no retry); 5xx /
  timeouts retry with exponential backoff (30s → 1h, 5 attempts).

### Inbound: connecting a monitoring tool

1. In the webhooks panel, pick the **default client** — inbound alerts create
   tickets on that client (leave it on "none" and every inbound alert is
   rejected with 409).
2. Enable the source you use. The panel shows the full URL:
   `POST {PUBLIC_URL}/api/webhooks/inbound/{source}/{secret}`.
   The URL **is** the credential — hand it to the vendor, keep it out of
   public places, and treat a leaked URL as a leaked secret (rotate below).
3. **Request-line ceiling (know before you choose):** the secret rides the
   URL path, so it can appear in vendor-side and proxy access logs, and in
   any tool that logs request lines. There is deliberately no body signature,
   no timestamp, and no replay window — this is a documented trade-off, and
   the decision is the operator's. The remedy is **secret rotation** in the
   panel (the old URL stops working immediately; the vendor's stored URL
   must be updated).

**Episode semantics** (all sources): a *down*-style alert creates a ticket
(subject `[{source}] {name} is down`, priority from the vendor severity, tag
`nms:{source}`) on the default client. A repeat *down* for the same monitored
object **updates that open ticket** (fresh update, re-open if it was closed)
— it never creates a second ticket. A recovery (*up*) closes it. Inbound
tickets are first-class tickets: they get an alias (`support+{n}@{domain}`),
show in the queue and portal, and are fully client-scoped — but they fire no
email, no notifications, and no outbound webhook fan-out (nothing auto-sends).

Status codes: 404 unknown source · 401 source disabled, not enabled yet, or
wrong secret (deliberately indistinguishable) · 400 body not recognized for
the source · 409 no default client · 200 `{status: created|updated|closed|noop}`.

#### Per-source recipes

Payload shapes marked *verified* were checked against the vendor's source or
official docs; shapes marked *contract* are the JSON Kipple documents —
vendors without a fixed JSON body need a small script/template that POSTs
exactly that shape. UptimeRobot sends form-encoded parameters (all
`application/x-www-form-urlencoded`); every other source below POSTs JSON.

**Uptime Kuma** (*verified* — default webhook notification body)
URL: `/api/webhooks/inbound/kuma/{secret}`. In the Kuma monitor's
notification settings add a *Webhook* notification with that URL; the default
body is used as-is (no template needed):

```json
{
  "heartbeat": { "monitorID": 42, "status": 0, "msg": "Ping failed" },
  "monitor": { "name": "Portal", "url": "https://portal.example" },
  "msg": "Ping failed"
}
```

`heartbeat.status`: 0 = down, 1 = up, 2 = pending and 3 = maintenance are
ignored. The dedupe key is `monitorID`.

**UptimeRobot** (*verified* — default notification variables, form-encoded)
URL: `/api/webhooks/inbound/uptimerobot/{secret}`. In the monitor's
*Notifications* add a *Webhook* with that URL (Kipple accepts the vendor's
default variables without a custom template). Dedupe key is `monitorID`;
`alertType` 1 = down, 2 = up, 3 = SSL/domain expiry (treated as down).

**OnlineOrNot** (*verified* — documented webhook JSON)
URL: `/api/webhooks/inbound/onlineornot/{secret}`. Configure the monitor's
webhook with that URL; the event JSON is used as-is. Dedupe key is the
heartbeat `id` for heartbeat events, otherwise the monitor `url`.
`event`: `uptime.down` / `uptime.up` / `heartbeat.down` / `heartbeat.up`
(status-page events are out of scope); `alert_priority` maps to ticket
priority.

**Zabbix** (*contract* — Zabbix webhooks are user-script driven; there is no
fixed vendor body). Point the trigger action's webhook at
`/api/webhooks/inbound/zabbix/{secret}` and POST this JSON from the action
script (macro-driven, e.g.):

```json
{
  "event": { "id": "{EVENT.ID}", "status": 0 },
  "host": { "name": "{HOST.NAME}" },
  "trigger": { "id": "{TRIGGER.ID}", "name": "{TRIGGER.NAME}" },
  "severity": "{TRIGGER.SEVERITY}"
}
```

`event.status`: 0 = PROBLEM (down), 1 = RESOLVED (up). Dedupe key is the
trigger id (falls back to `host:trigger name` when absent); severity words
(`disaster`, `high`, `average`, `warning`, `information`) map to ticket
priority.

**PRTG** (*contract* — PRTG has no native JSON alert webhook). In a PRTG
notification that fires on sensor state change, POST this JSON to
`/api/webhooks/inbound/prtg/{secret}` (macro-driven):

```json
{
  "objectid": "{sensorid}",
  "objectname": "{sensorname}",
  "state": "Down",
  "checkmessage": "{message}",
  "mapUrl": "https://prtg.example/overview?node={sensorid}"
}
```

`state`: `Up` = recovery, `Down` / `Error` = alerting. Dedupe key is
`objectid`.

**Watcher** (*contract* — minimal documented JSON). From your Watcher
workflow/alerting, POST to `/api/webhooks/inbound/watcher/{secret}`:

```json
{
  "target": "chk-7",
  "name": "Status page",
  "status": "down",
  "message": "optional details",
  "url": "https://status.example"
}
```

`status`: `down` / `alerting` / `critical` = alerting, `up` / `resolved` /
`ok` = recovery. Dedupe key is `target` (or `id`).

**Custom** (fully generic — the escape hatch for any monitor that can POST
JSON). POST to `/api/webhooks/inbound/custom/{secret}`:

```json
{
  "target": "svc-1",
  "status": "down",
  "name": "Search API",
  "severity": "critical",
  "message": "502",
  "url": "https://search.example"
}
```

`status`: `down` / `alerting` = alerting, `up` / `resolved` = recovery.
`severity`: `critical` / `urgent` → urgent, `high` → high, `normal` /
`medium` → normal, `low` → low. Dedupe key is `target` (or `id`). `name`,
`severity`, `message`, and `url` are optional.

#### Testing without a vendor

```sh
curl -s -X POST '{PUBLIC_URL}/api/webhooks/inbound/custom/{secret}' \
  -H 'content-type: application/json' \
  -d '{"target":"demo-1","status":"down","name":"Demo","severity":"high"}'
# → 200 {"status":"created","ticketId":"...","number":12}
curl -s -X POST '{PUBLIC_URL}/api/webhooks/inbound/custom/{secret}' \
  -H 'content-type: application/json' \
  -d '{"target":"demo-1","status":"up"}'
# → 200 {"status":"closed",...}
```

### Outbound: verifying the signature

Kipple sends `content-type: application/json` plus
`x-kipple-signature: <hex hmac-sha256>` computed over the **raw request
body** with the hook's secret. Verify by recomputing the digest over the
bytes you received and comparing in constant time, e.g. Node:

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function verifySignature(secret, rawBody, header) {
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'utf8')
  const got = Buffer.from(header ?? '', 'utf8')
  return expected.length === got.length && timingSafeEqual(expected, got)
}
```

A hook's secret is shown once at create time (the API only ever reports that
a secret exists) — store it where your receiver can read it.

## Operations

- **Upgrades**: bump `KIPPLE_TAG` (or let GitOps re-pull `latest`), re-deploy
  the stack. Migrations run on API boot; images are non-root and multi-stage.
- **Backups**: `pg_dump` cron plus the `db-data` volume (or Portainer
  snapshots on supported hosts) — and the `storage-data` volume, which
  holds the ticket-update attachment files (they are not in the database).
  Redis holds only job queues — no durable state.
- **Logs**: pino → stdout; Portainer → stack → container → Logs.
- **MCP server**: the `mcp` image speaks both transports — stdio (run it
  where the MCP client lives, e.g. `docker run -i --rm --network
  kipple_default -e KIPPLE_API_URL=http://api:3000 -e KIPPLE_API_KEY=kip_...
  ghcr.io/.../mcp`) and streamable HTTP (`KIPPLE_MCP_TRANSPORT=http`,
  `KIPPLE_MCP_HTTP_PORT` default 8080, `KIPPLE_MCP_HTTP_PATH` default
  `/mcp`, stateless mode). It needs a Kipple API key (`KIPPLE_API_KEY`) and
  talks to the REST API over HTTP — it never reaches in-process into the
  app. It is still run as a standalone container, not a compose service.
