FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY src/client ./client

ENV MCP_PULSE_PORT=3000
ENV MCP_PULSE_PROXY_PORT=3100
ENV NODE_ENV=production

EXPOSE 3000 3100
CMD ["node", "dist/cli.js", "dashboard"]
