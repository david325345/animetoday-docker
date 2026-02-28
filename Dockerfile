FROM node:18-alpine

WORKDIR /app

# Kopírovat package files
COPY package*.json ./

# Instalovat dependencies
RUN npm ci --only=production

# Kopírovat zbytek aplikace
COPY . .

# Expose port
EXPOSE 7000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:7000/manifest.json', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Spustit aplikaci
CMD ["node", "server.js"]
