# Build from the repo root: docker build -f apps/worker/Dockerfile .
FROM node:20-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/connectors/package.json packages/connectors/
RUN pnpm install --frozen-lockfile --filter @engine/worker...
COPY apps/worker apps/worker
COPY packages packages
ENV NODE_ENV=production OPS_DATA_DIR=/app/packages/db/data
WORKDIR /app/apps/worker
CMD ["pnpm", "start"]
