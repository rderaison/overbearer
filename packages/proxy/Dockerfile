FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src/ src/
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache tini
COPY package.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist/ dist/
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
EXPOSE 8080
