FROM node:22-alpine

RUN apk add --no-cache python3 make g++ vips-dev
RUN apk add --no-cache fontconfig ttf-dejavu font-noto

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

RUN apk del python3 make g++ && apk add --no-cache vips
RUN fc-cache -f

RUN mkdir -p /app/public/posters /app/data/users

COPY . .

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3002/health || exit 1

CMD ["node", "server.js"]
