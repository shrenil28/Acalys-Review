FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/review-worker/package.json apps/review-worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/webhook-gateway/package.json apps/webhook-gateway/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/code-intelligence/package.json packages/code-intelligence/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/model-gateway/package.json packages/model-gateway/package.json
COPY packages/review-engine/package.json packages/review-engine/package.json
COPY packages/providers/github/package.json packages/providers/github/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY . .
ARG VITE_ACALYS_DATA_MODE=api
ARG VITE_ACALYS_API_URL
ENV VITE_ACALYS_DATA_MODE=$VITE_ACALYS_DATA_MODE
ENV VITE_ACALYS_API_URL=$VITE_ACALYS_API_URL
RUN npm run build:clean
RUN npm prune --omit=dev --ignore-scripts

FROM node:22-alpine AS backend
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
ARG ACALYS_SERVICE
ENV ACALYS_SERVICE=$ACALYS_SERVICE
CMD ["node", "deploy/start-service.mjs"]

FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
