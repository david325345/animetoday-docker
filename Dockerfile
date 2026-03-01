FROM node:20-alpine

# Build tools for native dependencies
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

# Remove build tools to keep image small
RUN apk del python3 make g++

COPY . .

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3002/health || exit 1

CMD ["node", "server.js"]
