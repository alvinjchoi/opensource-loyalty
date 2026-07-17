FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
COPY spec ./spec
COPY tsconfig*.json ./
COPY vitest.config.ts ./
RUN npm ci && npm run build && npm prune --omit=dev --workspaces --include-workspace-root

FROM node:22-alpine AS runtime
WORKDIR /app
ENV HOST=0.0.0.0
ENV PORT=3210
ENV LIP_DATABASE_PATH=/data/reference.db
COPY --from=build /src/package.json /src/package-lock.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages ./packages
COPY deploy/sakura-sandbox/sakura-program.json /config/sakura-program.json
COPY deploy/sakura-sandbox/start-loyalty.sh /usr/local/bin/start-loyalty
RUN mkdir -p /data \
  && chmod +x /usr/local/bin/start-loyalty \
  && chown -R node:node /app /data /config
USER node
EXPOSE 3210
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3210/health >/dev/null || exit 1
CMD ["/usr/local/bin/start-loyalty"]
