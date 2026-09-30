# Web image: the built Angular app served by nginx, which also forwards /api to
# the API so the browser only ever talks to one address. Build from the root:
#   docker build -f infra/docker/web.Dockerfile -t frontdesk-web .

# ---------------------------------------------------------------- build
FROM node:24-slim AS build
ENV NG_CLI_ANALYTICS=false
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @frontdesk/shared --workspace @frontdesk/web

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build --workspace @frontdesk/shared && npm run build --workspace @frontdesk/web

# -------------------------------------------------------------- runtime
# The "unprivileged" nginx image runs as a non-root user and listens on 8080.
FROM nginxinc/nginx-unprivileged:stable-alpine AS runtime
COPY infra/docker/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY infra/docker/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/apps/web/dist/medical-ai-frontdesk/browser /usr/share/nginx/html
EXPOSE 8080
