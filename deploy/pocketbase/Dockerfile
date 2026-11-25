# PocketBase image: one static binary, migrations and hooks baked in.
#
# The zip is fetched from the GitHub release and verified against the pinned
# sha256 for the target architecture before anything is unpacked. Previously
# the download was an `ADD` of a hardcoded linux_amd64 URL with no checksum:
# it could not build for arm64 at all, and the binary was trusted on TLS
# alone. The checksums are the release's own checksums.txt for
# POCKETBASE_VERSION, and the amd64 one is the same value
# scripts/fetch-tools.sh verifies the e2e binary against, so the tests run the
# binary we ship (e2e/specs/supply-chain.spec.ts fails on drift).
ARG PB_VERSION=0.39.11

FROM alpine:3.20.10
# Not a floating minor: `3.20` is re-pointed on every Alpine patch release.
ARG PB_VERSION
ARG TARGETARCH
ARG PB_SHA256_AMD64=08b9fcda0d5fd42cb315dc15a36dfa121c993855bd635f01d347c31b4328ec34
ARG PB_SHA256_ARM64=8c785618840df7ebba795fdf4eba33a5fed64ac5307ad8023b955b4ebb82048b

# busybox sh has no pipefail, and the checksum step is a pipe
# (`echo … | sha256sum -c -`): without this, a failing download could pass.
SHELL ["/bin/ash", "-eo", "pipefail", "-c"]

# DL3018 is "pin apk package versions": base-image CVEs are handled by moving
# the alpine patch tag above; pinning every apk version per architecture would
# rot faster than it protects anything here.
# hadolint ignore=DL3018
RUN apk add --no-cache ca-certificates unzip \
 && case "${TARGETARCH}" in \
      amd64) sha="${PB_SHA256_AMD64}" ;; \
      arm64) sha="${PB_SHA256_ARM64}" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && wget -q -O /tmp/pb.zip \
      "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${TARGETARCH}.zip" \
 && echo "${sha}  /tmp/pb.zip" | sha256sum -c - \
 && unzip /tmp/pb.zip -d /pb/ && rm /tmp/pb.zip
COPY pb_migrations /pb/pb_migrations
COPY pb_hooks /pb/pb_hooks
EXPOSE 8090
CMD ["/pb/pocketbase", "serve", "--http=0.0.0.0:8090", "--dir=/pb/pb_data", "--migrationsDir=/pb/pb_migrations", "--hooksDir=/pb/pb_hooks"]
