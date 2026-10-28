# Alive — portable digital-life engine (CLI + voice call page)
# Build:  docker compose build
# Run:    docker compose up
# Docs:   README.md → Quick start (Docker)

FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build \
  && npm prune --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production \
    ALIVE_HOME=/data/alive \
    ALIVE_VOICE_HOST=0.0.0.0 \
    ALIVE_VOICE_PORT=8766

COPY --from=build /app /app

RUN mkdir -p /data/alive \
  && ln -sf /app/bin/cli.js /usr/local/bin/alive \
  && chmod +x /app/bin/cli.js

VOLUME ["/data/alive"]
EXPOSE 8766

# Voice/call page by default. Heartbeat: docker compose run --rm alive tick
# Requires LLM_API_KEY (or host-reused keys) via env — see .env.example
CMD ["node", "bin/cli.js", "voice"]
