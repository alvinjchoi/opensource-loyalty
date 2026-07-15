FROM node:22-alpine

WORKDIR /app

COPY . .
RUN npm ci && npm run build

ENV HOST=0.0.0.0
ENV PORT=3210

EXPOSE 3210

HEALTHCHECK --interval=5s --timeout=2s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3210/health >/dev/null || exit 1

CMD ["node", "packages/server/dist/cli.js"]
