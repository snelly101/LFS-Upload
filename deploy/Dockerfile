# syntax=docker/dockerfile:1.7
# Multi-stage build: shared package, API (tsc) and web UI (vite) in one image; the API serves apps/web/dist.
FROM node:22.12.0-bookworm-slim AS build
ENV CI=true PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY tests/e2e/package.json tests/e2e/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter '!@snelson/e2e'
COPY packages ./packages
COPY apps ./apps
RUN pnpm --filter @snelson/shared run build \
 && pnpm --filter @snelson/api run build \
 && pnpm --filter @snelson/web run build
# Re-install production dependencies only for the runtime packages (keeps pnpm's workspace links intact).
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && pnpm install --prod --frozen-lockfile --filter @snelson/api --filter @snelson/shared \
 && rm -rf apps/web/src apps/web/node_modules apps/api/src tests

FROM node:22.12.0-bookworm-slim AS runtime
ENV NODE_ENV=production WEB_DIST=/app/apps/web/dist
RUN groupadd -g 10001 app && useradd -u 10001 -g app -M -d /app -s /usr/sbin/nologin app
COPY --from=build --chown=app:app /app /app
WORKDIR /app/apps/api
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
