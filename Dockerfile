FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4173

COPY server ./server
COPY src/core.js ./src/core.js
COPY site ./site

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

CMD ["node", "server/server.mjs"]
