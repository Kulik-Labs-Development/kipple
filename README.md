# Kipple

Open-source, self-hosted ticketing and client portal for MSPs. Email-native
conversations, API-first (REST + MCP), time tracking, white-label themes,
Docker Compose deploy (Portainer-friendly).

> Status: **Phase 0 in progress** — monorepo scaffold + CI/CD live.

- Project plan & roadmap: [docs/PLAN.md](docs/PLAN.md)
- Agent instructions: [AGENTS.md](AGENTS.md)

## Development

```sh
pnpm install
pnpm dev                                    # api + web + worker in dev
docker compose -f infra/docker-compose.yml up -d db redis   # dev data stores
```

## CI/CD

- `CI` workflow — lint, typecheck, and tests on every push/PR
- `Images` workflow — builds and pushes
  `ghcr.io/kulik-labs-development/kipple/{api,worker,mcp}` on push to `main`
  and `v*` tags; the Portainer stack (`infra/docker-compose.yml`) pulls those
