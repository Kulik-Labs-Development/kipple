FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
# Copy EVERY workspace manifest before installing: pnpm links workspace
# packages (workspace:^ deps) only for members present at install time, so a
# missing manifest leaves that package unresolvable to esbuild at build time.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/mcp/package.json apps/mcp/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/mail/package.json packages/mail/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @kipple/worker build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S kipple && adduser -S kipple -G kipple
COPY --from=build --chown=kipple:kipple /app/apps/worker/dist ./dist
USER kipple
CMD ["node", "dist/index.cjs"]
