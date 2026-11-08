# Viru Empire CEO Panel — standalone deploy image (Bun).
FROM oven/bun:1-slim
WORKDIR /app

# Dependencies first (cached layer).
COPY package.json bun.lockb* ./
RUN bun install --production --frozen-lockfile 2>/dev/null || bun install --production

# App code + prebuilt client.
COPY server.ts ./
COPY src ./src
COPY client-dist ./client-dist

# SQLite data directory (Render free tier: survives sleeps, wiped on redeploy —
# keep Export / Backup copies safe).
RUN mkdir -p /app/data
EXPOSE 3000
ENV PORT=3000
ENV DB_PATH=/app/data/viru-empire.db
CMD ["bun", "./server.ts"]
