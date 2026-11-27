#!/usr/bin/env bash
# scripts/cluster/port-forward.sh - a kubectl port-forward that survives a roll.
#
# `kubectl port-forward deploy/c11n-caddy 18080:8080` resolves the workload to
# ONE pod and holds a connection to it. The moment that pod is replaced - a
# `helm upgrade` that changes the pod template, a rollout, a node drain - the
# forward dies with "failed to find sandbox" / "lost connection to pod", and
# every spec in an e2e run fails until somebody notices. This wrapper restarts
# it with a 1 s backoff, so a rollout costs a one-second blip, not a re-run.
#
# It is deliberately not a supervisor: no pidfiles, no daemons, no polling
# loops beyond the restart. Ctrl-C stops the child and exits 0.
#
# USAGE
#   scripts/cluster/port-forward.sh <target> <local:remote> [kubectl args...]
#
#   scripts/cluster/port-forward.sh deploy/c11n-caddy 18080:8080
#   scripts/cluster/port-forward.sh svc/c11n-pocketbase 18090:8090
#   NAMESPACE=c11n scripts/cluster/port-forward.sh statefulset/c11n-pocketbase 18090:8090
#
# ENV
#   NAMESPACE   namespace for the target (default: default, matching the
#               install script)
#   LOG         file the kubectl output is appended to
#               (default: ${TMPDIR:-/tmp}/c11n-port-forward-<local port>.log)
#   BACKOFF     seconds between attempts (default: 1)
#
# Everything after the two positional arguments is passed to `kubectl
# port-forward` verbatim (e.g. --address 0.0.0.0).
set -uo pipefail

usage() {
	printf 'usage: %s <target> <local:remote> [kubectl port-forward args...]\n' "$(basename "$0")" >&2
	printf '  target: deploy/<name>, svc/<name>, statefulset/<name> or pod/<name>\n' >&2
	printf '  e.g.   %s deploy/c11n-caddy 18080:8080\n' "$(basename "$0")" >&2
	exit 2
}

[ "$#" -ge 2 ] || usage
TARGET="$1"
PORTS="$2"
shift 2
EXTRA_ARGS=("$@")

NAMESPACE="${NAMESPACE:-default}"
BACKOFF="${BACKOFF:-1}"
LOCAL_PORT="${PORTS%%:*}"
LOG="${LOG:-${TMPDIR:-/tmp}/c11n-port-forward-$LOCAL_PORT.log}"

command -v kubectl >/dev/null || {
	printf 'error: kubectl is not on PATH\n' >&2
	exit 1
}

CHILD=""
cleanup() {
	# Only the child this script started: never a pattern kill (a `pkill -f
	# port-forward` matches the shell running it, and other operators' forwards).
	if [ -n "$CHILD" ] && kill -0 "$CHILD" 2>/dev/null; then
		kill "$CHILD" 2>/dev/null || true
		wait "$CHILD" 2>/dev/null || true
	fi
}
trap 'cleanup; exit 0' INT TERM

printf 'port-forward: %s %s -> %s (namespace %s), log %s\n' \
	"$TARGET" "$PORTS" "127.0.0.1:$LOCAL_PORT" "$NAMESPACE" "$LOG" >&2

while :; do
	kubectl port-forward "$TARGET" -n "$NAMESPACE" "$PORTS" "${EXTRA_ARGS[@]}" >>"$LOG" 2>&1 &
	CHILD=$!
	printf '%s port-forward started (pid %s)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$CHILD" >>"$LOG"
	wait "$CHILD"
	STATUS=$?
	# A clean SIGINT of the child (130) after our own cleanup: stop.
	if [ "$STATUS" -eq 130 ]; then
		cleanup
		exit 0
	fi
	printf '%s port-forward exited (%s); retrying in %ss\n' \
		"$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STATUS" "$BACKOFF" >>"$LOG"
	sleep "$BACKOFF"
done
