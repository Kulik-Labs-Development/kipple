# Deployment

Single-host deployment: one Docker Compose stack, Postgres + Redis, one public
entry point (`api:3000` serves the API and the built SPA). The target host is
a Portainer-managed Docker node, but the same files work with the plain
`docker compose` CLI.

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
| `COMPOSE_PROFILES` | no | — | `proxy` = bundled Caddy (auto-HTTPS); `dev` = mailpit + adminer. One value or `*` — comma lists are a known Portainer bug |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | no | `kipple` / `kipple` / `kipple` | Change the password in production |
| `DATABASE_URL` | no | `postgres://kipple:kipple@db:5432/kipple` | Point elsewhere only for an external Postgres |
| `REDIS_URL` | no | `redis://redis:6379` | |

## First run

Open `PUBLIC_URL` in a browser: the setup wizard creates the owner account
(which becomes the superuser) and sets the instance name. Signups stay closed
after the first user; agents are added by admin invitation later.

## Deploying

### docker compose CLI

```sh
git clone https://github.com/Kulik-Labs-Development/kipple.git
cd kipple/infra
cp ../.env.example .env    # then edit AUTH_SECRET, PUBLIC_URL, ...
docker compose --env-file .env up -d                      # Mode A (BYO proxy)
docker compose --env-file .env --profile proxy up -d      # Mode B (bundled Caddy)
docker compose --env-file .env --profile dev up -d        # + mailpit/adminer
```

### Portainer (CE or BE)

Stacks, upload, and Git-repo sources all work; the compose file uses no
features that require Business Edition (no bind mounts, no `start_interval`).

1. **Stacks → Add stack**, name it `kipple` (or anything), then:
   - **Web editor** — paste `infra/docker-compose.yml`, or
   - **Upload** — send the file, or
   - **Git repository** — source for `Kulik-Labs-Development/kipple`, branch
     `main`, compose path `infra/docker-compose.yml`. Git sources can enable
     **GitOps updates** (polling or webhook) with "re-pull image" for
     release-driven updates.
2. **Environment variables** (or *Load variables from .env file*):
   - `AUTH_SECRET` (required), `PUBLIC_URL`, and whatever else you're changing
     (`KIPPLE_TAG`, `TRUST_PROXY`, `POSTGRES_PASSWORD`, ...).
   - For the bundled proxy: `COMPOSE_PROFILES=proxy` and `TRUST_PROXY=true`.
3. Deploy. `depends_on ... service_healthy` is honored, so the API starts only
   once Postgres/Redis report healthy; DB migrations run automatically on API
   boot.

For repeat deployments, add a **custom template** (Templates → Custom →
Add, build method = Git repository pointing at the compose path above) so the
stack is one click per new instance.

**Portainer quirks to know**

- `COMPOSE_PROFILES` takes one profile name or `*`. Comma-separated lists are
  not activated (portainer/portainer#13033) — you never need more than one.
- Variables set in the stack's environment can be edited later without
  editing the compose file (Portainer leaves `${VAR}` references in place).
- The API container exposes no host ports in Mode A; your reverse proxy must
  reach it via the stack network (below).

## Reverse proxy

The app is proxy-agnostic by contract: `PUBLIC_URL` is the only place the
public address is configured, and `TRUST_PROXY` switches on
`X-Forwarded-For/-Proto/-Host` handling. Two modes:

### Mode B — bundled Caddy (default for one-command deploys)

Enable the `proxy` profile (see above) and set `TRUST_PROXY=true`. Caddy gets
automatic HTTPS (Let's Encrypt) once you point DNS at the host — replace
`:80` with your domain in the `CADDYFILE` env var of the `caddy` service
(edit the stack in Portainer, or the inlined copy in
`infra/docker-compose.yml`). `infra/Caddyfile` holds the same config for
reference.

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

## Operations

- **Upgrades**: bump `KIPPLE_TAG` (or let GitOps re-pull `latest`), re-deploy
  the stack. Migrations run on API boot; images are non-root and multi-stage.
- **Backups**: `pg_dump` cron plus the `db-data` volume (or Portainer
  snapshots on supported hosts). Redis holds only job queues — no durable
  state.
- **Logs**: pino → stdout; Portainer → stack → container → Logs.
- **MCP server**: the `mcp` image is a stdio server (run it where the MCP
  client lives, e.g. `docker run -i --rm --network kipple_default ghcr.io/.../mcp`);
  it is deliberately not a stack service until it ships an HTTP transport.
