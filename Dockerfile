FROM node:26.8.1-trixie-slim AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.app.json ./
RUN npm ci --no-audit --no-fund

COPY src/ src/
RUN npm run build


FROM node:26.8.1-trixie-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts


FROM node:26.8.1-trixie-slim

LABEL org.opencontainers.image.title="tracker-thanks-bot" \
      org.opencontainers.image.description="Auto-thanks bot for private trackers, driven by Radarr/Sonarr webhooks." \
      org.opencontainers.image.source="https://github.com/alorle/tracker-thanks-bot" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

COPY --from=deps /app/node_modules node_modules/

COPY --from=builder /app/dist/*.js dist/

# Fixed numeric UID/GID for predictable Kubernetes SecurityContext / volume perms.
RUN groupadd --system --gid 10001 appuser \
    && useradd --system --uid 10001 --gid 10001 --create-home --shell /sbin/nologin appuser \
    && mkdir -p /app/.cache /app/config \
    && chown -R appuser:appuser /app

ENV NODE_ENV=production \
    CACHE_DIR=/app/.cache \
    SITES_CONFIG_PATH=/app/config/sites.json \
    WEBHOOK_PORT=3000

VOLUME /app/.cache
VOLUME /app/config
EXPOSE 3000

USER 10001:10001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEBHOOK_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/index.js"]
CMD ["serve"]
