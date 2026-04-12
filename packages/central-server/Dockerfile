# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY packages/central-server/package*.json ./packages/central-server/

RUN npm ci --workspace=packages/central-server --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/central-server/tsconfig.json ./packages/central-server/
COPY packages/central-server/src ./packages/central-server/src

RUN npm run build --workspace=packages/central-server

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY package*.json ./
COPY packages/central-server/package*.json ./packages/central-server/

RUN npm ci --workspace=packages/central-server --include-workspace-root --omit=dev \
    && npm cache clean --force

COPY --from=builder /app/packages/central-server/dist ./packages/central-server/dist

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "packages/central-server/dist/index.js"]
