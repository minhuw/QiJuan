FROM node:22-bookworm

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json

RUN npm ci

COPY . .

RUN npm run build

# Pinned restic. The checksum is the linux amd64 build recorded in
# server/restic-release.json. Other architectures fail this step.
RUN set -eu \
 && apt-get update \
 && apt-get install -y --no-install-recommends bzip2 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && test "$(dpkg --print-architecture)" = "amd64" \
 && node --input-type=module -e "import { createHash } from 'node:crypto'; import { readFileSync, writeFileSync } from 'node:fs'; const pin = JSON.parse(readFileSync('/app/server/restic-release.json', 'utf8')); const response = await fetch(pin.url); if (!response.ok) { console.error('restic download failed'); process.exit(1); } const bytes = Buffer.from(await response.arrayBuffer()); const digest = createHash('sha256').update(bytes).digest('hex'); if (digest !== pin.sha256) { console.error('restic checksum mismatch'); process.exit(1); } writeFileSync('/tmp/restic.bz2', bytes);" \
 && bunzip2 -c /tmp/restic.bz2 > /usr/local/bin/restic \
 && chmod 755 /usr/local/bin/restic \
 && rm -f /tmp/restic.bz2 \
 && restic version

ARG QIJUAN_REVISION=dev
ENV NODE_ENV=production
ENV QIJUAN_DATA_DIR=/data
ENV QIJUAN_PORT=8080
ENV QIJUAN_REVISION=$QIJUAN_REVISION

RUN mkdir -p /data

VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
