FROM oven/bun:1

WORKDIR /init

# Copy dependency manifests first for better layer caching.
COPY package.json bun.lock tsconfig.json ./
COPY manager.ts wsClient.ts ./
COPY tools/ ./tools/
COPY agents/ ./agents/

RUN bun install --production

# The host workspace is mounted at /app; the worker code stays in /init.
ENV NODE_ENV=production
ENV PROJECT_DIR=/app
ENV WS_URL=ws://host.docker.internal:3000/ws
ENV LLM_ENDPOINT=http://host.docker.internal:3000/llm/chat/completions
ENV command=""
ENV attachments=""

CMD ["bun", "run", "/init/manager.ts"]
