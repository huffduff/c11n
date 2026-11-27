#!/usr/bin/env bash
# scripts/check-image-context.sh - prove the images' build stages can build,
# without a Docker daemon.
#
# Two Dockerfiles share one class of bug: a COPY or a WORKDIR that only fails on
# a builder (minutes later, on a machine with a daemon).
#
#   * deploy/caddy/Dockerfile is built from the REPO ROOT and its first stage is
#     `npm ci` plus `npm run build -w packages/overlay`. A COPY that forgets a
#     workspace manifest, or a .dockerignore entry that excludes a source dir,
#     only shows up as a failed `docker build` in CI.
#   * examples/demo-go-server/Dockerfile builds a Go module from a WORKDIR. It
#     ran `go build ./examples/demo-go-server` from the repo root, which has no
#     go.mod, and nothing caught it locally: the first failure was the in-cluster
#     arm64 build. The check below builds the module from the directory the
#     Dockerfile's WORKDIR names, with GOPROXY=off, so a missing module or a
#     wrong directory fails here.
#
# This copies exactly the paths the Dockerfile's COPY lines name into a scratch
# directory (no other repo files, so a missing COPY fails here too) and runs the
# same commands natively. Slow-ish (~a minute), so it is not part of
# `npm test`; CI runs it in the docker job's place while no image can be built
# locally.
#
# Usage: scripts/check-image-context.sh
# Exit: 0 the overlay and the demo server build from the copied set, 1 otherwise.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK="${C11N_IMAGE_CONTEXT_DIR:-$REPO_ROOT/.stack/image-context}"

log() { printf '%s\n' "$*" >&2; }

# The COPY sources of the overlay stage, verbatim. Keep in sync with
# deploy/caddy/Dockerfile (a source added there must be added here, which is
# the point of the check).
COPY_PATHS=(
	package.json
	package-lock.json
	packages/overlay/package.json
	examples/demo-vue/package.json
	examples/demo-go-server/go.mod
	e2e/package.json
	packages/overlay
)

command -v npm >/dev/null || { log "error: npm is not on PATH"; exit 1; }

rm -rf "$WORK"
mkdir -p "$WORK"
for path in "${COPY_PATHS[@]}"; do
	if [ ! -e "$REPO_ROOT/$path" ]; then
		log "error: the Dockerfile COPYs $path but it does not exist"
		exit 1
	fi
	mkdir -p "$WORK/$(dirname "$path")"
	if [ -d "$REPO_ROOT/$path" ]; then
		# Copy contents, not the directory itself: a manifest copied earlier
		# already created this path, and `cp -R dir dir` would nest it.
		mkdir -p "$WORK/$path"
		cp -R "$REPO_ROOT/$path/." "$WORK/$path/"
	else
		cp "$REPO_ROOT/$path" "$WORK/$path"
	fi
done

# node_modules must come from the lockfile, not from the copy.
rm -rf "$WORK/packages/overlay/node_modules" "$WORK/packages/overlay/dist"

log "check-image-context: installing from the copied manifests ($WORK)"
(cd "$WORK" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null)

log "check-image-context: building packages/overlay"
(cd "$WORK" && npm run build -w packages/overlay >/dev/null)

if [ ! -s "$WORK/packages/overlay/dist/overlay.js" ]; then
	log "error: the build produced no packages/overlay/dist/overlay.js"
	exit 1
fi

# ---- the demo upstream's go build ------------------------------------------
# examples/demo-go-server/Dockerfile: WORKDIR is the MODULE dir and the build is
# `go build ... .`. Reproduce that exactly - same cwd, same flags - from a copy
# that contains only what the Dockerfile COPYs. GOPROXY=off proves the claim in
# the Dockerfile's comment: stdlib only, nothing to download.
command -v go >/dev/null || { log "error: go is not on PATH (needed for the demo server check; see .tool-versions)"; exit 1; }

DEMO_DIR="$WORK/examples/demo-go-server"
rm -rf "$DEMO_DIR"
mkdir -p "$WORK/examples"
cp -R "$REPO_ROOT/examples/demo-go-server" "$DEMO_DIR"

log "check-image-context: building the demo server from examples/demo-go-server (the Dockerfile's WORKDIR)"
if ! ( cd "$DEMO_DIR" \
	&& CGO_ENABLED=0 GOFLAGS=-mod=mod GOPROXY=off GOCACHE="$WORK/.gocache" \
		go build -trimpath -ldflags="-s -w" -o "$WORK/demo-go-server" . ); then
	log "error: the demo server does not build from examples/demo-go-server; check the Dockerfile's WORKDIR and -o target"
	exit 1
fi
if [ ! -s "$WORK/demo-go-server" ]; then
	log "error: the demo server build produced no binary"
	exit 1
fi
log "check-image-context: ok - the caddy build stage and the demo server build from their COPY sets"
