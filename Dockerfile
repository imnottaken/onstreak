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
COPY --from=build /app/packages/react/package.json ./packages/react/
RUN npm ci --omit=dev --workspace @onstreak/engine && npm cache clean --force
COPY --from=build /app/packages/engine/dist ./packages/engine/dist
COPY examples/onstreak.config.json ./onstreak.config.json
# Run as the unprivileged user that ships with the node image.
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/engine/dist/main.js"]
