# syntax=docker/dockerfile:1

# ---- Build: the site is plain static files, so build once on the runner's own
# architecture (no QEMU) and copy the result into every platform's image.
FROM --platform=$BUILDPLATFORM node:25-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
RUN npm run build

# ---- Serve: non-root nginx (listens on 8080, runs as uid 101).
FROM nginxinc/nginx-unprivileged:stable-alpine

# The base image's OS packages can lag Alpine's security fixes. CACHE_BUST makes
# this layer re-run instead of being served from the build cache forever; CI
# passes the build date so each day's first build picks up new patches.
ARG CACHE_BUST=dev
USER root
RUN echo "apk cache bust: ${CACHE_BUST}" && apk upgrade --no-cache

# Set from the release git tag (see .github/workflows/docker-publish.yml);
# "dev" for a plain local `docker build`.
ARG VERSION=dev
LABEL org.opencontainers.image.title="Hullpatch" \
      org.opencontainers.image.description="In-browser STL repair that makes files slice cleanly in Bambu Studio" \
      org.opencontainers.image.source="https://github.com/hibikipr/hullpatch" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${VERSION}"

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/security-headers.conf /etc/nginx/hullpatch-headers.conf
COPY --from=build /src/dist /usr/share/nginx/html
RUN echo "${VERSION}" > /usr/share/nginx/html/version.txt

USER 101
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
