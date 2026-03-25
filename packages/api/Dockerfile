FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src/ src/
RUN npx tsc

FROM node:22-alpine AS ui-builder
WORKDIR /app
COPY ../ui/package.json ./
RUN npm install
COPY ../ui/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache tini
COPY package.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/src/db/schema.sql dist/db/schema.sql
COPY --from=ui-builder /app/dist/ public/
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
EXPOSE 3000
