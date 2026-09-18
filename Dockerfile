# Container image for Smithery-hosted deployments (and anyone who prefers
# Docker to npx). Runtime is stdio, so no ports are exposed.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY README.md LICENSE smithery.yaml ./
ENTRYPOINT ["node", "dist/index.js"]
