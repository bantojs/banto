# Node.js で動かす場合の最小イメージ（docs/run-on-node.md）。Cloudflare Workers では使わない。
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:node

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/node/server.js ./dist/node/server.js
# 自前の PostgreSQL にマイグレーションを当てるコマンド（docs/self-hosted-db.md）
COPY --from=build /app/dist/node/migrate.js ./dist/node/migrate.js
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]
EXPOSE 8787
# root で動かさない（公式イメージの node ユーザー）
USER node
CMD ["node", "dist/node/server.js"]
