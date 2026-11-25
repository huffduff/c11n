# Caddy with the replace-response plugin, at exactly the versions the e2e stack
# runs.
#
# KEEP THE DEFAULTS IN SYNC WITH scripts/tools.env: the e2e suite proves the
# native binary fetched from CADDY_VERSION + REPLACE_RESPONSE_REF, so a drift
# here means CI green-lights a different Caddy than the one we deploy
# (scripts/check-pins.mjs fails on drift).
#
# Two spellings of the same version on purpose: xcaddy wants the v-prefixed Go
# module version, Docker tags are published without it.
ARG CADDY_VERSION=2.11.4
ARG CADDY_GO_VERSION=v2.11.4
ARG REPLACE_RESPONSE_REF=80962887e4c680abfd1b11ce1403fa8cc0fdd3d6

FROM caddy:${CADDY_VERSION}-builder AS builder
ARG CADDY_GO_VERSION
ARG REPLACE_RESPONSE_REF
# The plugin is pinned to a commit sha, not a tag: replace-response has no
# tagged releases, so a floating version would make the proxy's HTML rewriting
# depend on whatever upstream pushed that day.
RUN xcaddy build ${CADDY_GO_VERSION} \
      --with github.com/caddyserver/replace-response@${REPLACE_RESPONSE_REF}

FROM caddy:${CADDY_VERSION}
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
