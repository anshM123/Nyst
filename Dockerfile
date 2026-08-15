# Nyst — production image.
#
# One image, three roles, chosen by the command:
#
#   web      node --experimental-strip-types scripts/startProduct.ts
#   worker   node --experimental-strip-types scripts/startWorker.ts
#   migrate  node --experimental-strip-types scripts/migrate.ts
#
# Nothing here is specific to any hosting provider. It needs PostgreSQL, a
# port, and environment variables. Production startup FAILS CLOSED on unsafe
# configuration — see src/product/config.ts for the exact rules.

# ---------------------------------------------------------------- build ----
FROM node:24-bookworm-slim AS build
WORKDIR /app

# Dependencies first, so a source-only change does not reinstall the world.
# The SDK manifest is copied too: the root depends on it by path, and npm ci
# reads it while building the tree.
COPY package.json package-lock.json ./
COPY packages/sdk/package.json ./packages/sdk/
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY tsconfig.scripts.json tsconfig.api.json ./
COPY packages/sdk/tsconfig.json ./packages/sdk/
COPY packages/sdk/src ./packages/sdk/src
COPY src ./src
COPY scripts ./scripts
COPY api ./api
COPY tests ./tests
RUN npm run build

# Reinstall production dependencies only. The build needs TypeScript; the
# running service does not, and every tool left in the image is attack surface.
RUN npm ci --omit=dev --no-audit --no-fund

# --------------------------------------------------------------- runtime ---
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NYST_HOST=0.0.0.0 \
    NYST_PORT=4080 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app

# `node` (uid 1000) ships with the base image. Nyst never needs to write to
# its own filesystem, so the whole tree stays owned by root and read-only to
# the service account.
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --from=build --chown=root:root /app/packages/sdk/dist ./packages/sdk/dist
COPY --chown=root:root package.json ./
COPY --chown=root:root scripts ./scripts
COPY --chown=root:root db ./db
COPY --chown=root:root public ./public

USER node
EXPOSE 4080

# Liveness only. Readiness (/ready) touches the database and belongs to the
# orchestrator, not to the container runtime: a database blip should take the
# instance out of the load-balancer pool, not restart the process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NYST_PORT||4080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# SIGTERM reaches PID 1 directly in exec form, which is what the graceful
# shutdown handlers in scripts/startProduct.ts are waiting for.
CMD ["node", "--experimental-strip-types", "scripts/startProduct.ts"]
