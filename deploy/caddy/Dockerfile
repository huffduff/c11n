# Caddy with the replace-response plugin, the overlay bundle, the static
# sign-in page and the Caddyfile baked in.
#
# BUILD CONTEXT IS THE REPO ROOT (the overlay is an npm workspace package):
#
#   docker build -f deploy/caddy/Dockerfile -t c11n-caddy:dev .
#
# docker-compose.yml and the CI docker job do the same; a context of
# deploy/caddy cannot see packages/overlay.
#
# Three stages:
#   1. overlay  - node builds packages/overlay/dist from the workspace
#   2. builder  - xcaddy builds Caddy with replace-response at a pinned commit
#   3. runtime  - the release Caddy image, non-root, with all assets in place
#
# KEEP THE DEFAULTS IN SYNC WITH scripts/tools.env AND .tool-versions: the e2e
# suite proves the native binary fetched from CADDY_VERSION +
# REPLACE_RESPONSE_REF, so a drift here means CI green-lights a different Caddy
# than the one we deploy (scripts/check-pins.mjs fails on drift). The node pin
# is checked against .tool-versions the same way.
#
# Two spellings of the same Caddy version on purpose: xcaddy wants the
# v-prefixed Go module version, Docker tags are published without it.
ARG CADDY_VERSION=2.11.4
ARG CADDY_GO_VERSION=v2.11.4
ARG REPLACE_RESPONSE_REF=80962887e4c680abfd1b11ce1403fa8cc0fdd3d6
ARG NODE_VERSION=24.19.0

# ---- 1. overlay bundle ------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS overlay
ARG NODE_VERSION
WORKDIR /src

# Only the manifests first, so the dependency layer is cached across source
# edits. Every workspace member's manifest is needed even though only the
# overlay is built: npm ci resolves the whole workspace tree from the root
# lockfile, and a missing member manifest makes it fail.
COPY package.json package-lock.json ./
COPY packages/overlay/package.json packages/overlay/
COPY examples/demo-vue/package.json examples/demo-vue/
COPY examples/demo-go-server/go.mod examples/demo-go-server/
COPY e2e/package.json e2e/
RUN npm ci --ignore-scripts

# Source of the overlay only. Its vite config emits dist/overlay.js.
COPY packages/overlay packages/overlay
RUN npm run build -w packages/overlay

# ---- 2. caddy with replace-response ----------------------------------------
FROM caddy:${CADDY_VERSION}-builder AS builder
ARG CADDY_GO_VERSION
ARG REPLACE_RESPONSE_REF
# The plugin is pinned to a commit sha, not a tag: replace-response has no
# tagged releases, so a floating version would make the proxy's HTML rewriting
# depend on whatever upstream pushed that day.
RUN xcaddy build ${CADDY_GO_VERSION} \
      --with github.com/caddyserver/replace-response@${REPLACE_RESPONSE_REF}

# ---- 3. runtime ------------------------------------------------------------
FROM caddy:${CADDY_VERSION}
COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# The official caddy image sets a FILE CAPABILITY on /usr/bin/caddy
# (`setcap cap_net_bind_service=+ep`, to bind 80/443 as a non-root user). Our
# pods run with `capabilities.drop: [ALL]` and
# `allowPrivilegeEscalation: false` (no_new_privs), and execve(2) refuses a
# binary whose file capability is not in the bounding set: the container died
# with `exec /usr/bin/caddy: operation not permitted` on the k3s cluster.
#
# Stripping it in the builder would not be enough: COPY --from overwrites an
# existing path in place, and overlayfs copy-up keeps the xattr, so the cap
# survives the copy. Strip it here, in the FINAL stage, so the guarantee is
# about the file we actually ship rather than about layer mechanics - and
# assert it, so a future base image that stops shipping libcap (or starts
# dropping caps back in) fails the BUILD instead of crash-looping a pod.
# `getcap` prints nothing for a file with no capabilities; the base image
# installs libcap for its own setcap, so this adds no package. Caddy listens on
# 8080 (C11N_LISTEN, EXPOSE below), so it needs no capability at all.
RUN setcap -r /usr/bin/caddy; \
    test -z "$(getcap /usr/bin/caddy)"

# The overlay bundle is served at /__c11n/* and the sign-in page at
# /__c11n/auth/*; the defaults in deploy/Caddyfile point here, so the chart
# needs no env override for either path.
COPY --from=overlay /src/packages/overlay/dist /srv/overlay
COPY packages/signin /srv/signin
COPY deploy/Caddyfile /etc/caddy/Caddyfile

# Caddy runs as uid/gid 65532 (numeric: Kubernetes runAsNonRoot cannot verify a
# named user). The official image runs as root and writes its autosave config
# under /config and its storage under /data; both are pre-created writable here
# (the chart mounts emptyDirs over them because the root filesystem is
# read-only). It listens on 8080, not 80, so no privileged-port capability is
# needed.
RUN mkdir -p /data /config \
 && chown -R 65532:65532 /data /config
ENV XDG_DATA_HOME=/data \
    XDG_CONFIG_HOME=/config \
    XDG_CACHE_HOME=/tmp \
    C11N_LISTEN=:8080 \
    C11N_OVERLAY_DIR=/srv/overlay \
    C11N_SIGNIN_DIR=/srv/signin
USER 65532:65532
EXPOSE 8080
