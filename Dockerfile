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
USER node
EXPOSE 3001
CMD ["node", "build/server/index.js"]
