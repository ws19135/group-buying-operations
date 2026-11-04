# 正式環境映像（Node 22）。多階段建置；以非 root 使用者執行；不內含任何密鑰（全部由環境變數於執行時注入）。
# 建置：docker build --build-arg BUILD_SHA=$(git rev-parse HEAD) --build-arg APP_VERSION=<版本> -t sdh-erp:<版本> .
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ARG BUILD_SHA=unknown
ARG APP_VERSION=dev
ENV NODE_ENV=production APP_ENV=production NEXT_TELEMETRY_DISABLED=1 BUILD_SHA=$BUILD_SHA APP_VERSION=$APP_VERSION PORT=3000 HOSTNAME=0.0.0.0
# postgresql-client：備份與還原演練用（pg_dump／pg_restore）
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client ca-certificates curl && rm -rf /var/lib/apt/lists/* \
 && groupadd -r erp && useradd -r -g erp -d /app erp
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY package.json next.config.mjs tsconfig.json ./
COPY migrations ./migrations
COPY scripts ./scripts
COPY src ./src
RUN chown -R erp:erp /app
USER erp
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1
CMD ["npm", "start"]
