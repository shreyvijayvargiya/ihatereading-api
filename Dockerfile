# Fly.io — Node API with Puppeteer (system Chromium)
FROM node:20-bookworm-slim

WORKDIR /app

# Chromium + common scrape/video deps
RUN apt-get update && apt-get install -y --no-install-recommends \
  chromium \
  ffmpeg \
  python3 \
  python-is-python3 \
  ca-certificates \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  xdg-utils \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3001
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NLLB_MODULE_PATH=./lib/nllbTranslate.local.js

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3001

CMD ["node", "index.js"]
