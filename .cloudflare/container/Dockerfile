# syntax=docker/dockerfile:1.7

# Wraps an AFFiNE server image for Cloudflare Containers. Nothing is compiled
# here. AFFINE_IMAGE is set through `image_vars` in wrangler.jsonc; point it at
# an image built from this repository to get the ticket MCP tools.
ARG AFFINE_IMAGE=ghcr.io/toeverything/affine:stable
FROM ${AFFINE_IMAGE}

# Cloudflare has no managed Redis. A local, non-persistent Redis is enough for
# AFFiNE's cache, locks and queues on a single instance. Set REDIS_SERVER_URL to
# use an external Redis instead.
RUN apt-get update && \
  apt-get install -y --no-install-recommends redis-server && \
  rm -rf /var/lib/apt/lists/*

# SMTP-to-HTTP bridge for Mail Mario, started when MAILMARIO_API_KEY is set.
COPY smtp-bridge/package.json smtp-bridge/package-lock.json /usr/local/lib/affine/smtp-bridge/
RUN npm ci --omit=dev --no-audit --no-fund --prefix /usr/local/lib/affine/smtp-bridge
COPY smtp-bridge/index.mjs /usr/local/lib/affine/smtp-bridge/

COPY --chmod=0755 start.sh /usr/local/bin/cloudflare-start.sh
COPY gen-config.mjs /usr/local/lib/affine/gen-config.mjs

EXPOSE 3010

CMD ["/usr/local/bin/cloudflare-start.sh"]
