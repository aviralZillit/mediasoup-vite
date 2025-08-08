# Multi-stage build for production scalability
FROM node:18-alpine AS deps

# Install system dependencies
RUN apk add --no-cache \
    build-base \
    python3 \
    python3-dev \
    py3-pip \
    linux-headers \
    valgrind \
    net-tools

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Development stage
FROM node:18-alpine AS development
RUN apk add --no-cache build-base python3 python3-dev py3-pip linux-headers valgrind net-tools
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 4443 40000-49999
CMD ["npm", "start"]

# Production stage
FROM node:18-alpine AS production

# Install only runtime dependencies
RUN apk add --no-cache \
    python3 \
    net-tools \
    curl \
    && addgroup -g 1001 -S nodejs \
    && adduser -S mediasoup -u 1001

WORKDIR /app

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=mediasoup:nodejs . .

# Create logs directory
RUN mkdir -p logs && chown mediasoup:nodejs logs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:4443/health || exit 1

# Security: Run as non-root user
USER mediasoup

# Expose ports
EXPOSE 4443
EXPOSE 40000-49999/udp
EXPOSE 40000-49999/tcp

# Use dumb-init for proper signal handling in containers
RUN apk add --no-cache dumb-init
ENTRYPOINT ["dumb-init", "--"]

# Start command
CMD ["node", "server.js"]
