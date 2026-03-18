FROM node:18-slim

# Install Chromium and dependencies
RUN apt-get update && apt-get install -y \
  chromium \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libnspr4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  xdg-utils \
  dumb-init \
  --no-install-recommends && \
  rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV CHROME_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app

# Copy package files and install deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Create data directory for WA sessions (mount Render disk here)
RUN mkdir -p /data/.wwebjs_auth && \
    ln -sf /data/.wwebjs_auth /app/.wwebjs_auth

EXPOSE 3000

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--max-old-space-size=256", "--optimize-for-size", "--gc-interval=100", "server.js"]
