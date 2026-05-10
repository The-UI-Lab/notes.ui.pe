# ── Build frontend ─────────────────────────────────────────────────────────
FROM node:20-alpine AS build-frontend

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── Build sync server ──────────────────────────────────────────────────────
FROM node:20-alpine AS build-server

WORKDIR /server
COPY server/package*.json ./
RUN npm ci
COPY server/ .
RUN npx tsc

# ── Runtime stage ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Install nginx
RUN apk add --no-cache nginx

# nginx config
RUN rm -f /etc/nginx/http.d/default.conf
COPY nginx.conf /etc/nginx/http.d/default.conf

# Static assets
COPY --from=build-frontend /app/dist /usr/share/nginx/html

# Sync server
WORKDIR /server
COPY --from=build-server /server/dist ./dist
COPY --from=build-server /server/node_modules ./node_modules
COPY --from=build-server /server/package.json ./

# Data directory for SQLite (mount as volume for persistence)
RUN mkdir -p /data/sync

# Entrypoint script to start both nginx and the sync server
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80

ENV SYNC_PORT=3001
ENV SYNC_DATA_DIR=/data/sync

CMD ["/entrypoint.sh"]
