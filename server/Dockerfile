# Build from the repository root:  docker build -f server/Dockerfile -t ski-ptt .
FROM node:22-alpine
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY web ../web
ENV PORT=8080 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "src/server.js"]
