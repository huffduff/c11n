# PocketBase image: one static binary, migrations and hooks baked in.
#
# The zip is fetched from the GitHub release and verified against the pinned
# sha256 for the target architecture before anything is unpacked. Previously
# the download was an `ADD` of a hardcoded linux_amd64 URL with no checksum:
# it could not build for arm64 at all, and the binary was trusted on TLS
# alone. The checksums are the release's own checksums.txt for
# POCKETBASE_VERSION, and the amd64 one is the same value
# scripts/fetch-tools.sh verifies the e2e binary against, so the tests run the
# binary we ship (scripts/check-pins.mjs fails on drift).
#
# Two stages on purpose:
#   fetch   - downloads and unpacks the release. Carries wget and unzip, which
#             nothing in the running image needs (they are the reachable,
#             CVE-prone tools, so they do not ship).
#   runtime - ca-certificates + tzdata + one static binary. No package manager,
#             no unzip, no download tool.
#
# Runs as uid/gid 65532 (numeric: Kubernetes runAsNonRoot cannot verify a named
# user). Ownership is set where the bytes are placed - COPY --chown for the
# binary, migrations and hooks, and an explicit chown on the one directory the
# process writes (/pb/pb_data) - so there is no `chown -R` promising something
# a later COPY then undoes. The chart additionally sets fsGroup 65532 for the
# PVC.
ARG PB_VERSION=0.39.11

# ---- 1. the release zip -----------------------------------------------------
FROM alpine:3.20.10 AS fetch
# Not a floating minor: `3.20` is re-pointed on every Alpine patch release.
ARG PB_VERSION
ARG TARGETARCH
ARG PB_SHA256_AMD64=08b9fcda0d5fd42cb315dc15a36dfa121c993855bd635f01d347c31b4328ec34
ARG PB_SHA256_ARM64=8c785618840df7ebba795fdf4eba33a5fed64ac5307ad8023b955b4ebb82048b

# Alpine's ash supports `pipefail`, but it is off unless the shell is started
# with it: the checksum step is a pipe (`echo … | sha256sum -c -`), and without
# `-o pipefail` a failing `sha256sum` on the right-hand side would be masked by
# a successful `echo`, so a tampered or truncated download could pass. This
# SHELL adds `-o pipefail` (plus `-e`) for every RUN in the stage.
SHELL ["/bin/ash", "-eo", "pipefail", "-c"]

# DL3018 is "pin apk package versions": base-image CVEs are handled by moving
# the alpine patch tag above; pinning every apk version per architecture would
# rot faster than it protects anything here.
# hadolint ignore=DL3018
RUN apk add --no-cache ca-certificates unzip wget \
 && case "${TARGETARCH}" in \
      amd64) sha="${PB_SHA256_AMD64}" ;; \
      arm64) sha="${PB_SHA256_ARM64}" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && wget -q -O /tmp/pb.zip \
      "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${TARGETARCH}.zip" \
 && echo "${sha}  /tmp/pb.zip" | sha256sum -c - \
 && mkdir -p /out \
 && unzip /tmp/pb.zip -d /out/ \
 && rm /tmp/pb.zip

# ---- 2. the image -----------------------------------------------------------
FROM alpine:3.20.10
ARG PB_VERSION

# hadolint ignore=DL3018
RUN apk add --no-cache ca-certificates tzdata \
 && addgroup -g 65532 -S nonroot \
 && adduser -u 65532 -S -G nonroot -H -s /sbin/nologin nonroot \
 && mkdir -p /pb/pb_data \
 && chown 65532:65532 /pb/pb_data

# Everything the process reads or executes is created with the right owner, so
# no recursive chown is needed (and there is no window where root-owned files
# sit under a path the comment claims is 65532's).
COPY --from=fetch --chown=65532:65532 /out/pocketbase /pb/pocketbase
COPY --chown=65532:65532 pb_migrations /pb/pb_migrations
COPY --chown=65532:65532 pb_hooks /pb/pb_hooks
ENV TZ=UTC
USER 65532:65532
EXPOSE 8090
# The binary is the ENTRYPOINT and the default arguments are the CMD. The split
# is load-bearing in Kubernetes: a container's `args` REPLACE the image CMD and
# leave the ENTRYPOINT alone, while a single CMD naming the binary means
# `args: [serve, ...]` makes the kubelet exec `serve` itself - which is exactly
# the `exec: "serve": executable file not found in $PATH` crash-loop the chart
# hit on k3s. With ENTRYPOINT set, the chart can pass args (or nothing) and
# `docker run` / deploy/docker-compose.yml, which set no command, still get the
# full default.
ENTRYPOINT ["/pb/pocketbase"]
CMD ["serve", "--http=0.0.0.0:8090", "--dir=/pb/pb_data", "--migrationsDir=/pb/pb_migrations", "--hooksDir=/pb/pb_hooks"]
