#!/usr/bin/env bash
# Install the pinned native binaries used by the e2e stack into .tools/.
#
#   CADDY_BIN / POCKETBASE_BIN  when set and executable, that binary is used
#                               as-is and no download/build happens for it
#   otherwise                   Caddy is built with xcaddy + replace-response,
#                               PocketBase is downloaded from its GitHub
#                               release and its sha256 is checked against
#                               scripts/tools.env (mismatch = hard failure)
#
# Later scripts locate the binaries through scripts/tools-lib.sh, which
# implements the same resolution: ${CADDY_BIN:-<repo>/.tools/caddy}.
#
# Versions live in scripts/tools.env (including the pinned xcaddy used to
# build Caddy). Requires bash, go (for Caddy only - pinned in .tool-versions),
# curl and either unzip or python3.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOLS_DIR="$REPO_ROOT/.tools"

# shellcheck source=scripts/tools.env
. "$SCRIPT_DIR/tools.env"

log() { printf '%s\n' "$*" >&2; }
die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

mkdir -p "$TOOLS_DIR"

# --- platform ---------------------------------------------------------------
# Fail on an unsupported arch before the (slow) Caddy build, not after it, when
# the PocketBase download would be the thing that cannot work.
ARCH="$(uname -m)"
HOST_UNSUPPORTED=""
case "$ARCH" in
x86_64 | amd64) ;;
*) HOST_UNSUPPORTED="the prebuilt PocketBase zip is linux_amd64 only; this host is $(uname -s)/$ARCH. Set POCKETBASE_BIN=/path/to/pocketbase (a local build) to continue" ;;
esac
if [ -n "$HOST_UNSUPPORTED" ] && [ -z "${POCKETBASE_BIN:-}" ]; then
	die "$HOST_UNSUPPORTED"
fi

# --- Caddy (with caddyserver/replace-response) -------------------------------
if [ -n "${CADDY_BIN:-}" ]; then
	[ -x "$CADDY_BIN" ] || die "CADDY_BIN=$CADDY_BIN is not executable"
	log "caddy: using CADDY_BIN=$CADDY_BIN (skipping build)"
elif [ -x "$TOOLS_DIR/caddy" ] &&
	"$TOOLS_DIR/caddy" version 2>/dev/null | head -n1 | grep -qF "$CADDY_VERSION" &&
	"$TOOLS_DIR/caddy" list-modules 2>/dev/null | grep -q 'http.handlers.replace_response'; then
	# Idempotent: re-running must not spend minutes rebuilding the same binary.
	log "caddy: $TOOLS_DIR/caddy is already $CADDY_VERSION with replace-response (skipping build)"
else
	go version >/dev/null 2>&1 ||
		die "go is required to build Caddy (found no working 'go'; see .tool-versions and 'asdf install'). Set CADDY_BIN to skip the build"
	log "caddy: building $CADDY_VERSION with replace-response@$REPLACE_RESPONSE_REF (xcaddy $XCADDY_VERSION)"
	go run "github.com/caddyserver/xcaddy/cmd/xcaddy@$XCADDY_VERSION" build "$CADDY_VERSION" \
		--with "github.com/caddyserver/replace-response@$REPLACE_RESPONSE_REF" \
		--output "$TOOLS_DIR/caddy"
	chmod +x "$TOOLS_DIR/caddy"
fi

CADDY_EXE="${CADDY_BIN:-$TOOLS_DIR/caddy}"
[ -x "$CADDY_EXE" ] || die "caddy binary not found at $CADDY_EXE"
if ! "$CADDY_EXE" list-modules | grep -q 'http.handlers.replace_response'; then
	die "caddy at $CADDY_EXE lacks the http.handlers.replace_response module"
fi

# --- PocketBase --------------------------------------------------------------
if [ -n "${POCKETBASE_BIN:-}" ]; then
	[ -x "$POCKETBASE_BIN" ] || die "POCKETBASE_BIN=$POCKETBASE_BIN is not executable"
	log "pocketbase: using POCKETBASE_BIN=$POCKETBASE_BIN (skipping download)"
elif [ -x "$TOOLS_DIR/pocketbase" ] &&
	"$TOOLS_DIR/pocketbase" --version 2>/dev/null | grep -qxF "pocketbase version $POCKETBASE_VERSION"; then
	# Idempotent like the Caddy build above: a matching binary is not
	# downloaded again.
	log "pocketbase: $TOOLS_DIR/pocketbase is already $POCKETBASE_VERSION (skipping download)"
else
	[ "$(uname -s)" = "Linux" ] || die "prebuilt PocketBase download is Linux-only (set POCKETBASE_BIN)"

	zip_name="pocketbase_${POCKETBASE_VERSION}_linux_amd64.zip"
	zip_url="https://github.com/pocketbase/pocketbase/releases/download/v${POCKETBASE_VERSION}/${zip_name}"
	zip_path="$TOOLS_DIR/$zip_name"
	sums_path="$TOOLS_DIR/$zip_name.sha256"

	log "pocketbase: downloading $zip_url"
	curl -fsSL --retry 3 -o "$zip_path" "$zip_url"

	# sha256, pinned in tools.env (from the release's checksums.txt). A
	# mismatch is fatal: never install a binary we cannot vouch for.
	printf '%s  %s\n' "$POCKETBASE_SHA256_LINUX_AMD64" "$zip_name" >"$sums_path"
	if ! (cd "$TOOLS_DIR" && sha256sum -c "$zip_name.sha256"); then
		rm -f "$zip_path" "$sums_path"
		die "PocketBase checksum mismatch for $zip_name; refusing to install"
	fi

	if command -v unzip >/dev/null 2>&1; then
		unzip -o -q "$zip_path" pocketbase -d "$TOOLS_DIR"
	else
		command -v python3 >/dev/null 2>&1 || die "unzip or python3 is required to extract $zip_name"
		python3 -m zipfile -e "$zip_path" "$TOOLS_DIR"
	fi
	rm -f "$zip_path" "$sums_path" "$TOOLS_DIR/CHANGELOG.md" "$TOOLS_DIR/LICENSE.md"
	chmod +x "$TOOLS_DIR/pocketbase"
fi

log "caddy:      ${CADDY_BIN:-$TOOLS_DIR/caddy} ($("${CADDY_BIN:-$TOOLS_DIR/caddy}" version | head -n1))"
log "pocketbase: ${POCKETBASE_BIN:-$TOOLS_DIR/pocketbase} ($("${POCKETBASE_BIN:-$TOOLS_DIR/pocketbase}" --version))"
