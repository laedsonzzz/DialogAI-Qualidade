# Multi-stage Dockerfile: build frontend (Vite) and run Express API + static files
# Base images
FROM node:20-slim AS base

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY

ENV HTTP_PROXY=${HTTP_PROXY}
ENV HTTPS_PROXY=${HTTPS_PROXY}
ENV NO_PROXY=${NO_PROXY}

# Builder stage
FROM base AS builder
WORKDIR /app

# 1. Copia apenas o package.json para ignorar o lockfile do Mac
COPY package.json ./
# 2. Gera um lockfile novo para Linux e instala tudo (incluindo Rollup correto)
RUN npm install

# Copy source and build
COPY . .
RUN npm run build

# Runtime stage
FROM base AS runtime
WORKDIR /app

# 3. Copia apenas o package.json aqui também
COPY package.json ./
# 4. Usa 'install' em vez de 'ci' para garantir compatibilidade e ignorar lockfile antigo
RUN npm install --omit=dev

# Copy server and built frontend
COPY server/ ./server/
COPY --from=builder /app/dist ./dist/

# Expose port
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server/index.js"]