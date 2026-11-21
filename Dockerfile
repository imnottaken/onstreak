FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/engine/package.json ./packages/engine/
COPY --from=build /app/packages/sdk/package.json ./packages/sdk/
RUN npm ci --omit=dev --workspace @onstreak/engine
COPY --from=build /app/packages/engine/dist ./packages/engine/dist
COPY examples/onstreak.config.json ./onstreak.config.json
EXPOSE 8787
CMD ["node", "packages/engine/dist/main.js"]
