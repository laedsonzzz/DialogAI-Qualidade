# Multi-stage Dockerfile: build frontend (Vite) and run Express API + static files
# Base images
FROM node:20-alpine AS base

# Builder stage
FROM base AS builder
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Runtime stage
FROM base AS runtime
WORKDIR /app

# Install only production dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy server and built frontend
COPY server/ ./server/
COPY dist/ ./dist/

# Expose port
ENV PORT=3000
EXPOSE 3000

# Runtime environment variables (provided via docker-compose/.env)
# - DATABASE_URL
# - AZURE_OPENAI_ENDPOINT_1
# - AZURE_OPENAI_API_KEY_1
# - AZURE_OPENAI_API_VERSION_1
# - AZURE_OPENAI_DEPLOYMENT_NAME_1

CMD ["node", "server/index.js"]