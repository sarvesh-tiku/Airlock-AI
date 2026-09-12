# Airlock control plane. No build step, no package install.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY bin ./bin
# State lives in a volume; secrets come from the environment, never the image.
ENV HOST=0.0.0.0 PORT=3000 AIRLOCK_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
USER node
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/invariants >/dev/null || exit 1
CMD ["node", "src/server.js"]
