# shellcheck shell=bash
# Binary resolution for the native c11n stack.
#
# This is the single place that decides which caddy/pocketbase binaries the
# scripts use. Order for each tool:
#   1. $CADDY_BIN / $POCKETBASE_BIN, when set (must be executable: CI cache,
#      a prebuilt binary, or a system install)
#   2. otherwise <repo>/.tools/<tool>, installed by scripts/fetch-tools.sh
#
# Usage: . "$(dirname "$0")/tools-lib.sh"; caddy_bin; pocketbase_bin
# Requires bash. c11n_repo_root is computed once, at source time.

C11N_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

c11n_repo_root() {
	printf '%s\n' "$C11N_REPO_ROOT"
}

# c11n_resolve_bin <ENV_VAR_NAME> <tool-name>
c11n_resolve_bin() {
	local env_name="$1" tool="$2" override local_bin
	override="${!env_name:-}"
	if [ -n "$override" ]; then
		if [ ! -x "$override" ]; then
			printf 'error: %s=%s is not executable\n' "$env_name" "$override" >&2
			return 1
		fi
		printf '%s\n' "$override"
		return 0
	fi
	local_bin="$C11N_REPO_ROOT/.tools/$tool"
	if [ ! -x "$local_bin" ]; then
		printf 'error: %s not found; run scripts/fetch-tools.sh (or set %s)\n' \
			"$local_bin" "$env_name" >&2
		return 1
	fi
	printf '%s\n' "$local_bin"
}

caddy_bin() {
	c11n_resolve_bin CADDY_BIN caddy
}

pocketbase_bin() {
	c11n_resolve_bin POCKETBASE_BIN pocketbase
}
