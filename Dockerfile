FROM node:20-alpine
# Force rebuild - version 2

WORKDIR /app

# Kopírovat package files
COPY package*.json ./

# Instalovat dependencies s verbose logging
RUN npm install --omit=dev --verbose

# Kopírovat zbytek aplikace
COPY . .

# Expose port
EXPOSE 3002

# Healthcheck - používá wget místo node (jednodušší)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3002/manifest.json || exit 1

# Spustit aplikaci
CMD ["node", "server.js"]
