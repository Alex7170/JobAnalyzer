# Matches the "playwright" version pinned in package.json (^1.48.2).
# This image ships Node + Chromium/Firefox/WebKit with all OS deps already
# installed, so we don't need to separately apt-get browser dependencies.
FROM mcr.microsoft.com/playwright:v1.48.2-jammy

WORKDIR /app

# Install deps first so this layer is cached as long as package*.json don't change
COPY package.json package-lock.json ./
RUN npm ci

# App source
COPY tsconfig.json ./
COPY src ./src
COPY prompts ./prompts

# data/ is where jobs.json / assessments.json / jobs.xlsx live.
# It's meant to be a mounted volume (see docker-compose.yml), but create it
# here too so a plain `docker run` without a volume still works.
RUN mkdir -p data

ENV NODE_ENV=production

# No default command: this image is meant to run one of the pipeline
# scripts at a time. Prefer docker-compose (handles the two env files +
# volumes for you); the plain docker equivalent is:
#   docker run --rm --env-file .env.secrets --env-file .env.default \
#     -v "$PWD/data:/app/data" -v "$PWD/prompts:/app/prompts" \
#     jobscz-scraper npm run scrape
CMD ["npm", "run", "dev"]
