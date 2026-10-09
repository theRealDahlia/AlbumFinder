# Album Finder: build the site, then run it with only what production needs.
#
#   docker build -t album-finder .
#   docker run -p 3000:3000 -v album-finder-data:/data -e CONTACT=you@example.com album-finder
#
# /data holds cached store lists and covers, and Discogs inventories:
# keep it on a volume so it survives redeploys.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY scripts ./scripts
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
# "degraded" (an upstream service failing) still answers 200: the site works from cache.
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "fetch('http://localhost:' + process.env.PORT + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server/index.js"]
