### Stage 1 — build do frontend
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

### Stage 2 — runtime enxuto
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY index.html ./
COPY vite.config.ts ./
COPY tsconfig.json ./

EXPOSE 5000
CMD ["npx", "tsx", "server/index.ts"]
