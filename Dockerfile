FROM node:20-alpine
RUN apk add --no-cache openssl curl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN npx prisma generate

RUN npm run build

# Docker-level health check. Coolify reads this, and so does `docker ps`, so a
# container that is up but not yet serving is visible as such rather than
# silently receiving traffic. curl is already installed above.
HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

CMD ["npm", "run", "docker-start"]
