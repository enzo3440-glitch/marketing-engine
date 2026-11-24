# Build from the repo root: docker build -f apps/web/Dockerfile .
FROM node:20-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/connectors/package.json packages/connectors/
COPY packages/advisor/package.json packages/advisor/
RUN pnpm install --frozen-lockfile --filter @engine/web...

FROM deps AS build
COPY apps/web apps/web
COPY packages packages
RUN NEXT_STANDALONE=1 pnpm --filter @engine/web build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
# Marketing map seed (+ private CMO export if it was present at build time).
COPY --from=build /app/packages/db/data ./packages/db/data
ENV OPS_DATA_DIR=/app/packages/db/data
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
