# OpenRows: ONE image for the three Compose services `api` (node dist/index.js), `worker`
# (node dist/worker.js) and the `migrate` one-shot (node dist/migrate.js), per ADR-004. The api
# also serves the built client (CLIENT_DIR), so one origin serves the app and the API.
# Stages:
#   build → full install, then builds shared + server (tsc, with the SDK and the MCP server it
#           mounts at /mcp) and the client (Vite)
#   deps  → production node_modules for server + shared (and their workspace deps, the SDK and
#           the MCP server) only (npm ci --omit=dev)
#   oss   → node + those node_modules + the server, shared, SDK and MCP server dist, the SQL
#           migrations and the client's static files; runs `node <entry>.js` DIRECTLY as PID 1,
#           as user `node`, so SIGTERM reaches the process's shutdown handler (npm doesn't
#           forward signals).
# Build from the repo root:
#   docker build -f docker/Dockerfile -t openrows:local .

# Pinned by digest (docker/README.md "Image pins"): the tag names it, the digest is what is pulled.
ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

FROM ${NODE_IMAGE} AS build
WORKDIR /app
# npm ci needs every workspace manifest to validate the single lockfile. The root `prepare`
# script (scripts/install-hooks.js) skips the git hooks here: there is no .git.
COPY package.json package-lock.json tsconfig.base.json ./
COPY scripts/install-hooks.js scripts/
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/sdk/package.json packages/sdk/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/n8n-nodes-openrows/package.json packages/n8n-nodes-openrows/
COPY packages/blocks/package.json packages/blocks/
RUN npm ci --no-audit --no-fund
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/client packages/client
COPY packages/sdk packages/sdk
COPY packages/mcp-server packages/mcp-server
# The server's tsc -b builds the SDK (ESM) and the MCP server through its project references.
RUN npm run build -w @openrows/shared -w @openrows/server -w @openrows/client

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/install-hooks.js scripts/
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/sdk/package.json packages/sdk/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/n8n-nodes-openrows/package.json packages/n8n-nodes-openrows/
COPY packages/blocks/package.json packages/blocks/
RUN npm ci --omit=dev --no-audit --no-fund --workspace @openrows/server --workspace @openrows/shared \
    && npm cache clean --force

# Last, so a plain `docker build` gives the open-source image.
FROM ${NODE_IMAGE} AS oss
ENV NODE_ENV=production \
    PORT=3000 \
    CLIENT_DIR=/app/packages/client/dist
WORKDIR /app
# Production dependencies and the workspace manifests their symlinks point at.
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/package.json ./
COPY --from=deps /app/packages/shared/package.json packages/shared/
COPY --from=deps /app/packages/server/package.json packages/server/
COPY --from=deps /app/packages/sdk/package.json packages/sdk/
COPY --from=deps /app/packages/mcp-server/package.json packages/mcp-server/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/sdk/dist/esm packages/sdk/dist/esm
COPY --from=build /app/packages/mcp-server/dist packages/mcp-server/dist
# The SQL the migrate one-shot applies (dist/db/migrate.js reads ../../drizzle).
COPY --from=build /app/packages/server/drizzle packages/server/drizzle
COPY --from=build /app/packages/client/dist packages/client/dist
WORKDIR /app/packages/server
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
