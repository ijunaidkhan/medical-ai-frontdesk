# API image. Build from the repository root:
#   docker build -f infra/docker/api.Dockerfile -t frontdesk-api .
#
# Two stages: the first compiles TypeScript with all dev tools; the second holds
# only production dependencies and the compiled output, and runs as a non-root user.

# ---------------------------------------------------------------- build
FROM node:24-slim AS build
WORKDIR /app

# Dependency manifests first, so this layer is reused until they change.
# (All three workspace manifests are needed for the lockfile to match.)
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @frontdesk/shared --workspace @frontdesk/api

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build --workspace @frontdesk/shared && npm run build --workspace @frontdesk/api

# -------------------------------------------------------------- runtime
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @frontdesk/shared --workspace @frontdesk/api && npm cache clean --force

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist
# Plain-SQL migrations, read at run time by the migration command.
COPY apps/api/migrations apps/api/migrations

USER node
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "dist/main.js"]
