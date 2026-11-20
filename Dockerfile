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

# ---- Serve: non-root nginx (listens on 8080, runs as uid 101). The slim variant
# leaves out the njs, XSLT, GeoIP and image-filter modules, which this site doesn't use.
FROM nginxinc/nginx-unprivileged:stable-alpine-slim

# The base image's packages can lag security fixes. CACHE_BUST makes these layers
# re-run instead of being served from the build cache forever; CI passes the build
# date so each day's first build picks up new patches.
ARG CACHE_BUST=dev
USER 0
RUN echo "apk cache bust: ${CACHE_BUST}" && apk upgrade --no-cache

# nginx itself comes from nginx.org's own Alpine repository, not Alpine's, so the
# upgrade above never touches it. Upgrade it from that repository, verifying nginx's
# signing key the same way the base image does (key hash from its Dockerfile).
RUN set -eu; \
    KEY_SHA512="e09fa32f0a0eab2b879ccbbc4d0e4fb9751486eedda75e35fac65802cc9faa266425edf83e261137a2f4d16281ce2c1a5f4502930fe75154723da014214f0655"; \
    wget -q -O /tmp/nginx_signing.rsa.pub https://nginx.org/keys/nginx_signing.rsa.pub; \
    echo "$KEY_SHA512 */tmp/nginx_signing.rsa.pub" > /tmp/nginx_signing.sha512; \
    sha512sum -c /tmp/nginx_signing.sha512; \
    rm /tmp/nginx_signing.sha512; \
    mv /tmp/nginx_signing.rsa.pub /etc/apk/keys/; \
    apk upgrade --no-cache --repositories-file /dev/null \
      -X "https://nginx.org/packages/alpine/v$(cut -d. -f1,2 /etc/alpine-release)/main" nginx; \
    nginx -v

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
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
