# ── Tool installer stage ──────────────────────────────────────────────────────
FROM alpine:3.20 AS tools

RUN apk add --no-cache curl bash

# kubectl — pin to a known stable version for reproducibility
ARG KUBECTL_VERSION=v1.31.0
RUN curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
      -o /usr/local/bin/kubectl \
    && chmod +x /usr/local/bin/kubectl \
    && kubectl version --client

# helm
ARG HELM_VERSION=v3.16.0
RUN curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" \
      | tar -xz -C /usr/local/bin --strip-components=1 linux-amd64/helm \
    && chmod +x /usr/local/bin/helm \
    && helm version

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY packages/cluster-agent/package*.json ./packages/cluster-agent/

RUN npm ci --workspace=packages/cluster-agent --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/cluster-agent/tsconfig.json ./packages/cluster-agent/
COPY packages/cluster-agent/src ./packages/cluster-agent/src

RUN npm run build --workspace=packages/cluster-agent

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY package*.json ./
COPY packages/cluster-agent/package*.json ./packages/cluster-agent/

RUN npm ci --workspace=packages/cluster-agent --include-workspace-root --omit=dev \
    && npm cache clean --force

COPY --from=builder /app/packages/cluster-agent/dist ./packages/cluster-agent/dist
COPY --from=tools /usr/local/bin/kubectl /usr/local/bin/kubectl
COPY --from=tools /usr/local/bin/helm /usr/local/bin/helm

USER appuser

CMD ["node", "packages/cluster-agent/dist/index.js"]
