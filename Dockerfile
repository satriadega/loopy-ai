FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm ci --workspace frontend

COPY frontend/ ./frontend/
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN npm ci --workspace backend --omit=dev --omit=optional \
    && mkdir -p backend/data backend/outputs \
    && chown node:node backend/data backend/outputs

COPY backend/ ./backend/
COPY --from=frontend-build /app/frontend/dist/ ./frontend/dist/

USER node
EXPOSE 3001
CMD ["node", "backend/server.js"]
