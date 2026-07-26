FROM node:22-alpine

WORKDIR /app

# Install deps first so this layer is cached unless package.json changes.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
ENV DATA_DIR=/data
RUN mkdir -p /data

# Render injects PORT; server.js already reads process.env.PORT.
EXPOSE 3000

CMD ["node", "src/server.js"]