# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

FROM node:22-alpine AS production
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
# Inside a container the API must listen on all interfaces (the app default is 127.0.0.1).
ENV HOST=0.0.0.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build --chown=node:node /app/dist ./dist

USER node
EXPOSE 8000
CMD ["node", "dist/main.js"]
