# The gateway is one process: an HTTP server plus the background workers that
# retry dispatches and sweep deadlines. The console ships inside the same
# image — `npm run build` produces both halves, dist/ and dist/web.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# Migrations and their runner travel with the image so a deployed service can
# apply them itself (`insta compute exec <service> -- npm run migrate`).
COPY migrations ./migrations
COPY scripts/migrate.mjs ./scripts/migrate.mjs

# Must match the port passed to the platform. The server binds FLEET_PORT, else
# the platform's PORT, else this.
EXPOSE 8790

CMD ["node", "--enable-source-maps", "dist/index.js"]
