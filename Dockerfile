FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build/server ./build/server
COPY --from=build /app/server/db/migrations ./server/db/migrations
# Priečinok pre filesystem object storage — vlastní ho node, aby naň sadol
# prázdny named volume s rovnakými právami (inak by USER node nemal write).
RUN mkdir -p /data/objects && chown -R node:node /data
USER node
EXPOSE 3001
CMD ["node", "build/server/index.js"]

# Frontend: zbuildený React SPA (dist/) servírovaný Caddym, ktorý zároveň
# robí reverse proxy na /api a automatické HTTPS. Znovu použije build stage.
FROM caddy:2-alpine AS web
COPY --from=build /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
