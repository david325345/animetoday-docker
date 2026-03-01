FROM node:20-alpine

# Build tools + vips for sharp (image processing)
RUN apk add --no-cache python3 make g++ vips-dev

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

# Remove build tools but keep vips runtime
RUN apk del python3 make g++ && \
    apk add --no-cache vips

# Create posters directory
RUN mkdir -p /app/public/posters

COPY . .

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3002/health || exit 1

CMD ["node", "server.js"]
