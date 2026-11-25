#!/usr/bin/env bash
# scripts/stack.sh up|down|status - the real c11n stack from native binaries.
#
# Starts the background services the e2e suite needs, without Docker:
#   pocketbase :18090  (data, migrations and hooks copied into $C11N_STACK_DIR)
#   upstream   :15173  (C11N_FIXTURE=vite, the default: demo-vue via vite dev)
#              :15174  (C11N_FIXTURE=go: the built demo-vue served by
#                       examples/demo-go-server, the production topology)
#   caddy      :18080  (deploy/Caddyfile via C11N_* env overrides)
#
# The two fixtures exist because the dogfood app is served by Vite in dev and
# by a Go backend in production (ADR 0001). The proxy has to be proven in front
# of both, so the same suite runs twice, once per fixture, with a fresh stack.
#
# Binaries resolve through scripts/tools-lib.sh: $CADDY_BIN / $POCKETBASE_BIN
# when set, else .tools/ (run scripts/fetch-tools.sh first).
#
# State ($C11N_STACK_DIR, default <repo>/.stack, gitignored):
#   <svc>.log      service stdout/stderr
#   <svc>.pid      PID of the service's process group leader (setsid)
#   creds.json     superuser credentials + base URLs for the e2e suite
#
# `down` kills only what our pidfiles point at, by process group. It never
# uses pkill/pgrep patterns: a `pkill -f` pattern matches the shell running it
# (it killed the assessment session), and a stray `killall` can take out an
# unrelated dev server on the same box.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/tools-lib.sh
. "$SCRIPT_DIR/tools-lib.sh"

STATE_DIR="${C11N_STACK_DIR:-$REPO_ROOT/.stack}"
PB_PORT=18090
DEMO_PORT=15173
# Keep in sync with GO_PORT in e2e/fixtures.ts (specs cannot read this file).
GO_PORT=15174
CADDY_PORT=18080
FIXTURE="${C11N_FIXTURE:-vite}"
case "$FIXTURE" in
vite | go) ;;
*)
	printf "error: C11N_FIXTURE must be 'vite' or 'go' (got '%s')\n" "$FIXTURE" >&2
	exit 1
	;;
esac
# The port Caddy proxies to, and the port preflight must guard.
if [ "$FIXTURE" = go ]; then
	UPSTREAM_PORT="$GO_PORT"
else
	UPSTREAM_PORT="$DEMO_PORT"
fi
# The demo vite is the workspace's hoisted install: never `npx vite`, which
# would silently download an unpinned copy when node_modules is missing.
DEMO_DIR="$REPO_ROOT/examples/demo-vue"
VITE_BIN="$REPO_ROOT/node_modules/.bin/vite"
GO_SERVER_DIR="$REPO_ROOT/examples/demo-go-server"
GO_BIN="$STATE_DIR/demo-go-server"
ADMIN_EMAIL="e2e-admin@c11n.test"
SERVICES="pocketbase demo caddy"
START_TIMEOUT="${C11N_STACK_TIMEOUT:-30}"
# Set to 1 only once `up` has every service healthy; the EXIT trap reads it.
C11N_UP_OK=0

log() { printf '%s\n' "$*" >&2; }
die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

pid_file() { printf '%s/%s.pid' "$STATE_DIR" "$1"; }
log_file() { printf '%s/%s.log' "$STATE_DIR" "$1"; }

# is_alive <pid>: the process exists. Zombies and unrelated pids are filtered
# by callers that also compare the process group.
is_alive() {
	[ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null
}

read_pid() {
	local file
	file="$(pid_file "$1")"
	[ -s "$file" ] || return 1
	head -n1 "$file"
}

# pgid_of <pid>: prints the process group id, empty if the pid is gone.
pgid_of() {
	ps -o pgid= -p "$1" 2>/dev/null | tr -d ' '
}

# service_markers <name>: substrings of the command line(s) we expect for that
# service, one per line. Killing by pidfile is only safe while the pid still
# runs what we started: after a crash or reboot the pid may have been reused by
# an unrelated process, and the pgid==pid check alone cannot tell the
# difference.
#
# `demo` lists both fixtures' commands on purpose: `down` runs from the e2e
# teardown, which may or may not be handed the C11N_FIXTURE that started the
# stack. Each marker carries its port (and, for go, the .stack binary path), so
# an unrelated `vite` on this box can never match.
service_markers() {
	case "$1" in
	pocketbase) printf '%s\n' 'pocketbase serve' ;;
	caddy) printf '%s\n' 'caddy run' ;;
	demo) printf '%s\n' "--port $DEMO_PORT" "$GO_BIN --addr 127.0.0.1:$GO_PORT" ;;
	*) return 1 ;;
	esac
}

# cmdline_of <pid>: the full argv of the process, empty if it is gone.
cmdline_of() {
	ps -o args= -p "$1" 2>/dev/null | head -n1
}

# pid_is_service <name> <pid>: live, group leader, and its argv still matches
# the service. Anything else means the pidfile outlived what it described.
pid_is_service() {
	local name="$1" pid="$2" pgid marker args
	is_alive "$pid" || return 1
	pgid="$(pgid_of "$pid" || true)"
	[ "$pgid" = "$pid" ] || return 1
	args="$(cmdline_of "$pid" || true)"
	while IFS= read -r marker; do
		[ -n "$marker" ] || continue
		case "$args" in
		*"$marker"*) return 0 ;;
		esac
	done < <(service_markers "$name" || true)
	return 1
}

# port_in_use <port>: succeeds when something accepts TCP on 127.0.0.1:<port>
# or [::1]:<port>. A bash /dev/tcp probe: `ss`/`lsof` are not installed
# everywhere, and this is the check that keeps `up` from adopting a foreign
# listener as our service. The IPv6 probe is best effort: where bash or the
# kernel does not support /dev/tcp on ::1 that probe just fails and the v4
# check alone decides.
port_in_use() {
	local host
	for host in 127.0.0.1 ::1; do
		( : </dev/tcp/"$host"/"$1" ) 2>/dev/null && return 0
	done
	return 1
}

# preflight_ports: refuse to start on top of anything already listening. A
# foreign listener would otherwise answer the health checks while our own
# process died ("port in use"), and caddy would happily proxy it.
#
# Both fixture ports are checked whichever fixture was selected: switching
# C11N_FIXTURE between runs is normal, and a stack left behind by the other
# fixture still owns its upstream port.
preflight_ports() {
	local port name busy=""
	for port in "$PB_PORT" "$DEMO_PORT" "$GO_PORT" "$CADDY_PORT"; do
		case "$port" in
		"$PB_PORT") name=pocketbase ;;
		"$DEMO_PORT") name="demo upstream (vite fixture)" ;;
		"$GO_PORT") name="demo upstream (go fixture)" ;;
		*) name=caddy ;;
		esac
		if port_in_use "$port"; then
			log "error: port $port ($name) is already in use by another process"
			busy=1
		fi
	done
	if [ -n "$busy" ]; then
		log "refusing to start: those ports belong to a process that is not this stack"
		log "  inspect the owner with: ss -ltnp | grep -E ':($PB_PORT|$DEMO_PORT|$GO_PORT|$CADDY_PORT)\\b'"
		log "  or stop a previous stack with: scripts/stack.sh down"
		exit 1
	fi
}

# start_service <name> <command...>
# Runs the command in its own session (so the whole tree - node -> vite, and
# any shell wrapper - shares one process group), logging to <name>.log.
# setsid is required: without it the child never becomes a process-group
# leader, so `down` could not kill the whole tree safely.
start_service() {
	local name="$1"
	shift
	local log_path pidfile pid pgid i
	log_path="$(log_file "$name")"
	pidfile="$(pid_file "$name")"

	: >"$log_path"
	setsid nohup "$@" >>"$log_path" 2>&1 <"/dev/null" &
	pid=$!
	printf '%s\n' "$pid" >"$pidfile"

	# In a non-interactive shell the child is not a group leader, so setsid
	# execs in place and $! is the new session/group leader. If that ever
	# stops holding, fail loudly instead of killing the wrong group later.
	# Poll: the pgid read can lag the fork by a few ms, and a service that
	# exits this early must be reported as such, not as a pgid mismatch.
	pgid=""
	for i in $(seq 1 20); do
		if ! is_alive "$pid"; then
			printf 'error: %s exited during startup (pid %s)\n' "$name" "$pid" >&2
			log "---- $log_path (tail) ----"
			tail -n 40 "$log_path" >&2 || true
			return 1
		fi
		pgid="$(pgid_of "$pid" || true)"
		[ "$pgid" = "$pid" ] && break
		sleep 0.1
	done
	if [ "$pgid" != "$pid" ]; then
		printf 'error: %s did not start in its own process group (pid=%s pgid=%s)\n' \
			"$name" "$pid" "${pgid:-gone}" >&2
		log "---- $log_path (tail) ----"
		tail -n 40 "$log_path" >&2 || true
		return 1
	fi
	log "$name: started (pid $pid, log $log_path)"
}

# wait_for <name> <url> [<url>...]: poll until every URL answers, bounded by
# START_TIMEOUT seconds. On timeout, dump the service's log tail.
#
# The recorded pid must be alive on every poll: a URL that answers while our
# own process is dead means something else owns the port, and reporting "up"
# then would hand the whole suite to a foreign server.
wait_for() {
	local name="$1"
	shift
	local deadline=$((SECONDS + START_TIMEOUT)) url ok pid
	while :; do
		pid="$(read_pid "$name" || true)"
		if [ -z "$pid" ] || ! is_alive "$pid"; then
			printf 'error: %s exited during startup (pid %s is gone; %s)\n' \
				"$name" "${pid:-unknown}" "$*" >&2
			log "---- $(log_file "$name") (tail) ----"
			tail -n 40 "$(log_file "$name")" >&2 || true
			return 1
		fi
		ok=1
		for url in "$@"; do
			curl -fs -o /dev/null --max-time 2 "$url" 2>/dev/null || ok=0
		done
		[ "$ok" -eq 1 ] && return 0
		if [ "$SECONDS" -ge "$deadline" ]; then
			printf 'error: %s did not become healthy within %ss (%s)\n' \
				"$name" "$START_TIMEOUT" "$*" >&2
			log "---- $(log_file "$name") (tail) ----"
			tail -n 40 "$(log_file "$name")" >&2 || true
			return 1
		fi
		sleep 0.5
	done
}

# running_services: names whose pidfile points at a live process group that
# still looks like the service.
running_services() {
	local svc pid
	for svc in $SERVICES; do
		pid="$(read_pid "$svc" || true)"
		[ -n "$pid" ] || continue
		pid_is_service "$svc" "$pid" && printf '%s\n' "$svc"
	done
	return 0
}

# up_cleanup: EXIT trap while `up` runs. A failure after the first service
# starts would otherwise leave it (and its port) behind, and the next `up`
# would refuse to start. Every failure path therefore ends in `down`.
up_cleanup() {
	local status=$?
	trap - EXIT
	if [ "${C11N_UP_OK:-0}" -ne 1 ]; then
		log "startup failed; stopping services that did start"
		cmd_down || true
	fi
	exit "$status"
}

# build_go_fixture: build the SPA bundle and the Go server binary. The binary
# (not `go run`) is what start_service launches: with `go run` the group leader
# would be the go tool, the real server a child of it, and the cmd marker check
# would have nothing meaningful to match.
build_go_fixture() {
	local build_log
	build_log="$(log_file demo-build)"
	command -v go >/dev/null 2>&1 ||
		die "go is required for C11N_FIXTURE=go (pinned in .tool-versions; run 'asdf install')"
	: >"$build_log"
	log "demo: building the SPA bundle (npm run build -w examples/demo-vue)"
	if ! (cd "$REPO_ROOT" && npm run build -w examples/demo-vue) >>"$build_log" 2>&1; then
		log "---- $build_log (tail) ----"
		tail -n 40 "$build_log" >&2 || true
		die "building examples/demo-vue failed"
	fi
	log "demo: go build -o $GO_BIN ."
	if ! (cd "$GO_SERVER_DIR" && go build -o "$GO_BIN" .) >>"$build_log" 2>&1; then
		log "---- $build_log (tail) ----"
		tail -n 40 "$build_log" >&2 || true
		die "building examples/demo-go-server failed"
	fi
}

cmd_up() {
	local svc pid pw pb caddy running
	running="$(running_services | tr '\n' ' ')"
	if [ -n "${running// /}" ]; then
		die "stack already running (${running% }); run 'scripts/stack.sh down' first"
	fi

	# Before anything starts: a listener on our ports is not ours (or is a
	# stack whose pidfiles we cannot see), and adopting it is worse than failing.
	preflight_ports

	command -v setsid >/dev/null 2>&1 ||
		die "setsid is required (util-linux): each service must run in its own process group so 'down' can stop its whole tree"

	# The local stack's upstream is always plain http, so verifying TLS is the
	# only meaningful setting. An ambient C11N_UPSTREAM_TLS would either be
	# silently ignored or (as "insecure") misdescribe the stack; refuse instead.
	case "${C11N_UPSTREAM_TLS:-verify}" in
	"" | verify) ;;
	*)
		die "C11N_UPSTREAM_TLS=${C11N_UPSTREAM_TLS} does not apply to the local stack: its upstream is http://127.0.0.1:$UPSTREAM_PORT (plain http, no TLS). Unset it, or set C11N_UPSTREAM_TLS=verify."
		;;
	esac

	[ -x "$VITE_BIN" ] ||
		die "$VITE_BIN is missing; run 'npm ci' at the repo root (the demo must not fetch its own vite)"

	[ -f "$REPO_ROOT/packages/overlay/dist/overlay.js" ] ||
		die "packages/overlay/dist/overlay.js is missing; run 'npm run build' at the repo root"

	# Fail fast: the go fixture's build is the slowest and most failure-prone
	# step of `up`, so it runs before anything is started (and before the EXIT
	# trap can have a service to clean up).
	if [ "$FIXTURE" = go ]; then
		mkdir -p "$STATE_DIR"
		build_go_fixture
	fi

	C11N_UP_OK=0
	trap up_cleanup EXIT

	pb="$(pocketbase_bin)"
	caddy="$(caddy_bin)"

	# Fresh state for the services, but keep pb_data across runs so the demo
	# keeps its comments unless the caller removes the directory.
	mkdir -p "$STATE_DIR/pb_data" "$STATE_DIR/caddy/data" "$STATE_DIR/caddy/config"
	rm -rf "$STATE_DIR/pb_migrations" "$STATE_DIR/pb_hooks"
	cp -a "$REPO_ROOT/deploy/pocketbase/pb_migrations" "$STATE_DIR/pb_migrations"
	cp -a "$REPO_ROOT/deploy/pocketbase/pb_hooks" "$STATE_DIR/pb_hooks"

	pw="$(openssl rand -hex 16 2>/dev/null ||
		head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
	[ -n "$pw" ] || die "could not generate a superuser password"

	# Phase 3 identity (ADR 0006). `pb_hooks/bootstrap.pb.js` creates the first
	# owner when the users collection has none, and prints a single-use invite
	# link. The link lands in $STATE_DIR/pocketbase.log, which is where
	# e2e/fixtures.ts (bootstrapInviteLink) reads it from — proving an operator
	# can find it the same way. Both values can be overridden from the caller's
	# environment; they are exported here so the hook, which runs inside BOTH
	# children below (the upsert CLI boots the app with this hooks dir, then
	# serve), sees them. The hook is a no-op once an owner exists, so re-running
	# `up` on an existing pb_data does not mint a second owner or link.
	export C11N_OWNER_EMAIL="${C11N_OWNER_EMAIL-owner@c11n.test}"
	export C11N_PUBLIC_URL="${C11N_PUBLIC_URL-http://127.0.0.1:$CADDY_PORT}"

	# Bootstrap before serve: the CLI applies migrations and writes the
	# superuser while it holds the database exclusively. Doing it against a
	# running serve hits the same SQLite file from a second process.
	log "pocketbase: upserting superuser $ADMIN_EMAIL"
	if ! "$pb" superuser upsert "$ADMIN_EMAIL" "$pw" \
		--dir "$STATE_DIR/pb_data" \
		--migrationsDir "$STATE_DIR/pb_migrations" \
		--hooksDir "$STATE_DIR/pb_hooks" \
		>>"$(log_file pocketbase)" 2>&1; then
		log "---- $(log_file pocketbase) (tail) ----"
		tail -n 40 "$(log_file pocketbase)" >&2 || true
		die "pocketbase superuser upsert failed"
	fi

	# umask 077 in a subshell: the file is never briefly world-readable, which
	# a post-hoc chmod would allow.
	(
		umask 077
		printf '{"email":"%s","password":"%s","pbUrl":"http://127.0.0.1:%s","baseUrl":"http://127.0.0.1:%s"}\n' \
			"$ADMIN_EMAIL" "$pw" "$PB_PORT" "$CADDY_PORT" >"$STATE_DIR/creds.json"
	)
	chmod 600 "$STATE_DIR/creds.json"

	start_service pocketbase "$pb" serve \
		--http "127.0.0.1:$PB_PORT" \
		--dir "$STATE_DIR/pb_data" \
		--migrationsDir "$STATE_DIR/pb_migrations" \
		--hooksDir "$STATE_DIR/pb_hooks"
	wait_for pocketbase "http://127.0.0.1:$PB_PORT/api/health"

	if [ "$FIXTURE" = go ]; then
		start_service demo "$GO_BIN" \
			--addr "127.0.0.1:$GO_PORT" \
			--dir "$DEMO_DIR/dist"
	else
		(
			cd "$DEMO_DIR"
			start_service demo "$VITE_BIN" --host 127.0.0.1 --port "$DEMO_PORT" --strictPort
		)
	fi
	wait_for demo "http://127.0.0.1:$UPSTREAM_PORT/"

	(
		export C11N_LISTEN=":$CADDY_PORT"
		export C11N_PB_ADDR="127.0.0.1:$PB_PORT"
		export C11N_OVERLAY_DIR="$REPO_ROOT/packages/overlay/dist"
		export C11N_SIGNIN_DIR="$REPO_ROOT/packages/signin"
		export C11N_UPSTREAM="http://127.0.0.1:$UPSTREAM_PORT"
		# Always "verify": the upstream is plain http (see the guard in up), and
		# an empty value would make Caddy read it as set.
		export C11N_UPSTREAM_TLS="verify"
		export XDG_DATA_HOME="$STATE_DIR/caddy/data"
		export XDG_CONFIG_HOME="$STATE_DIR/caddy/config"
		start_service caddy "$caddy" run \
			--config "$REPO_ROOT/deploy/Caddyfile" \
			--adapter caddyfile
	)
	wait_for caddy "http://127.0.0.1:$CADDY_PORT/__c11n/pb/api/health"

	log "caddy:      http://127.0.0.1:$CADDY_PORT (overlay + proxied PocketBase)"
	log "pocketbase: http://127.0.0.1:$PB_PORT (admin: /_/)"
	log "upstream:   http://127.0.0.1:$UPSTREAM_PORT ($FIXTURE fixture)"
	log "credentials: $STATE_DIR/creds.json (superuser $ADMIN_EMAIL)"
	C11N_UP_OK=1
	trap - EXIT
	log "stack is up"
}

# stop_service <name>: terminate the recorded process group, by pidfile only.
stop_service() {
	local name="$1" pidfile pid pgid i marker args matched one
	pidfile="$(pid_file "$name")"
	pid="$(read_pid "$name" || true)"
	if [ -z "$pid" ]; then
		rm -f "$pidfile"
		return 0
	fi
	if ! is_alive "$pid"; then
		log "$name: not running (stale pidfile)"
		rm -f "$pidfile"
		return 0
	fi
	marker="$(service_markers "$name" | tr '\n' ' ' || true)"
	args="$(cmdline_of "$pid" || true)"
	matched=""
	while IFS= read -r one; do
		[ -n "$one" ] || continue
		case "$args" in
		*"$one"*) matched=1 ;;
		esac
	done < <(service_markers "$name" || true)
	if [ -n "$marker" ] && [ -z "$matched" ]; then
		log "warning: $name pid $pid does not look like '$marker' (cmd: ${args:-unreadable}); leaving it alone"
		log "$name: removed stale pidfile $pidfile"
		rm -f "$pidfile"
		return 0
	fi
	pgid="$(pgid_of "$pid" || true)"
	if [ "$pgid" != "$pid" ]; then
		log "warning: $name pid $pid is not a process-group leader (pgid ${pgid:-?}); leaving it alone"
		log "$name: removed stale pidfile $pidfile"
		rm -f "$pidfile"
		return 0
	fi
	kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
	for i in $(seq 1 40); do
		is_alive "$pid" || break
		sleep 0.25
	done
	if is_alive "$pid"; then
		log "$name: still alive after SIGTERM; sending SIGKILL"
		kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
		sleep 0.5
	fi
	rm -f "$pidfile"
	log "$name: stopped"
}

cmd_down() {
	local svc
	for svc in caddy demo pocketbase; do
		stop_service "$svc"
	done
	log "stack is down"
}

cmd_status() {
	local svc pid state
	for svc in $SERVICES; do
		pid="$(read_pid "$svc" || true)"
		if [ -n "$pid" ] && pid_is_service "$svc" "$pid"; then
			state="running (pid $pid)"
		else
			state="stopped"
		fi
		printf '%-11s %s\n' "$svc" "$state"
	done
	if [ -f "$STATE_DIR/creds.json" ]; then
		printf '%-11s %s\n' "creds" "$STATE_DIR/creds.json"
	fi
	return 0
}

case "${1:-}" in
up) cmd_up ;;
down) cmd_down ;;
status) cmd_status ;;
*)
	printf 'usage: %s up|down|status\n' "$(basename "$0")" >&2
	exit 2
	;;
esac
