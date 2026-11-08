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

# No local data directory: the panel stores everything in Turso (a hosted
# database), because Render's free tier wipes the server's own files
# whenever it sleeps or redeploys. TURSO_DATABASE_URL / TURSO_AUTH_TOKEN
# are set in the Render dashboard, never in this file.
EXPOSE 3000
ENV PORT=3000
CMD ["bun", "./server.ts"]
