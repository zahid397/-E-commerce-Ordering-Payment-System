FROM node:20-slim AS base
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    NODE_ENV=production

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./

EXPOSE 5000

# Applies pending migrations, then starts the API. In Docker Compose,
# `depends_on` + a healthcheck ensures Postgres is actually ready first.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
