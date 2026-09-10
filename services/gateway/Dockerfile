# Node 24 runs TypeScript directly via type stripping, so there is no build step
# and no compiled output to keep in sync with the source.
FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

CMD ["node", "src/index.ts"]
