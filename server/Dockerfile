# Build from the repository root:  docker build -f server/Dockerfile .
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY plugin/package.json plugin/
RUN npm ci
COPY shared shared
COPY server server
RUN npm run build -w server

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8787
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY plugin/package.json plugin/
RUN npm ci --omit=dev -w server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/dist/index.js"]
