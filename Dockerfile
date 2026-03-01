FROM node:20-alpine

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application code
COPY . .

# Expose port (must match PORT env)
EXPOSE 3002

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3002/health || exit 1

# Run
CMD ["node", "server.js"]
