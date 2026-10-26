# Runtime-only image from an already-bundled service (dist/index.js built on the host with
# `npm run build`). Used by `scripts/build-images.sh --prebuilt` on machines where running
# npm inside Docker is too slow or memory-hungry. Same runtime as node-service.Dockerfile.
FROM node:24-alpine
ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1
WORKDIR /app
COPY --chown=node:node index.js index.js.map ./
USER node
CMD ["node", "--enable-source-maps", "index.js"]
