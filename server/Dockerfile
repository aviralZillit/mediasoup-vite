# Multi-stage build for production-grade mediasoup server
FROM node:18-bullseye AS base

# Install system dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    python3-pip \
    valgrind \
    net-tools \
    curl \
    htop \
    vim \
    && rm -rf /var/lib/apt/lists/*

# Create app user for security
RUN groupadd -r mediasoup && useradd -r -g mediasoup mediasoup

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Development stage
FROM base AS development
RUN npm ci
COPY . .
CMD ["npm", "run", "dev"]

# Production stage
FROM base AS production

# Copy source code
COPY --chown=mediasoup:mediasoup . .

# Create logs directory
RUN mkdir -p /app/logs && chown mediasoup:mediasoup /app/logs

# Create directory for runtime data
RUN mkdir -p /app/data && chown mediasoup:mediasoup /app/data

# Set proper permissions
RUN chown -R mediasoup:mediasoup /app

# Switch to non-root user
USER mediasoup

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Expose ports
EXPOSE 3000 4443 44443-44499/udp

# Set environment variables
ENV NODE_ENV=production
ENV DEBUG=mediasoup-demo-server:INFO*,mediasoup-demo-server:WARN*,mediasoup-demo-server:ERROR*

# Start the application
CMD ["node", "server.js"]
