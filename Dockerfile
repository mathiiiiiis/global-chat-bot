FROM node:22-alpine
RUN apk add --no-cache dumb-init
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY src ./src
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production
ENV GC_DATA_FILE=/data/synced.json
USER node
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
