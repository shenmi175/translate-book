FROM node:22-bookworm-slim AS root-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS web-deps
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS web-build
WORKDIR /app
COPY --from=web-deps /app/web/node_modules ./web/node_modules
COPY web ./web
RUN npm run build --prefix web

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    pandoc \
    chromium \
    fonts-noto-cjk \
    fontconfig \
    poppler-utils \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=8787

COPY --from=root-deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server
COPY scripts ./scripts
COPY docs ./docs
COPY --from=web-build /app/web/dist ./web/dist
COPY .env.example ./.env.example
RUN chmod +x ./scripts/container-entrypoint.sh

EXPOSE 8787

ENTRYPOINT ["./scripts/container-entrypoint.sh"]
CMD ["node", "server/index.js"]
