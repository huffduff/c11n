#!/usr/bin/env bash
# scripts/stack.sh up|down|status - the real c11n stack from native binaries.
#
# Starts the three services the e2e suite needs, without Docker:
#   pocketbase :18090  (data, migrations and hooks copied into $C11N_STACK_DIR)
#   demo-vue   :15173  (vite dev server, the default upstream)
#   caddy      :18080  (deploy/Caddyfile via C11N_* env overrides)
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
CADDY_PORT=18080
ADMIN_EMAIL="e2e-admin@c11n.test"
SERVICES="pocketbase demo caddy"
START_TIMEOUT="${C11N_STACK_TIMEOUT:-30}"

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

# port_in_use <port>: succeeds when something accepts TCP on 127.0.0.1:<port>.
# A bash /dev/tcp probe: `ss`/`lsof` are not installed everywhere, and this is
# the check that keeps `up` from adopting a foreign listener as our service.
port_in_use() {
	( : </dev/tcp/127.0.0.1/"$1" ) 2>/dev/null
}

# preflight_ports: refuse to start on top of anything already listening. A
# foreign listener would otherwise answer the health checks while our own
# process died ("port in use"), and caddy would happily proxy it.
preflight_ports() {
	local port name busy=""
	for port in "$PB_PORT" "$DEMO_PORT" "$CADDY_PORT"; do
		case "$port" in
		"$PB_PORT") name=pocketbase ;;
		"$DEMO_PORT") name=demo ;;
		*) name=caddy ;;
		esac
		if port_in_use "$port"; then
			log "error: port $port ($name) is already in use by another process"
			busy=1
		fi
	done
	if [ -n "$busy" ]; then
		log "refusing to start: those ports belong to a process that is not this stack"
		log "  inspect the owner with: ss -ltnp | grep -E ':($PB_PORT|$DEMO_PORT|$CADDY_PORT)\\b'"
		log "  or stop a previous stack with: scripts/stack.sh down"
		exit 1
	fi
}

# start_service <name> <command...>
# Runs the command in its own session (so the whole tree - npx -> node -> vite,
# and any shell wrapper - shares one process group), logging to <name>.log.
start_service() {
	local name="$1"
	shift
	local log_path pidfile pid pgid
	log_path="$(log_file "$name")"
	pidfile="$(pid_file "$name")"

	: >"$log_path"
	if command -v setsid >/dev/null 2>&1; then
		setsid nohup "$@" >>"$log_path" 2>&1 <"/dev/null" &
	else
		log "warning: setsid not found; child processes may outlive 'down'"
		nohup "$@" >>"$log_path" 2>&1 <"/dev/null" &
	fi
	pid=$!
	printf '%s\n' "$pid" >"$pidfile"

	# In a non-interactive shell the child is not a group leader, so setsid
	# execs in place and $! is the new session/group leader. If that ever
	# stops holding, fail loudly instead of killing the wrong group later.
	sleep 0.3
	pgid="$(pgid_of "$pid" || true)"
	if [ "$pgid" != "$pid" ]; then
		printf 'error: %s did not start in its own process group (pid=%s pgid=%s)\n' \
			"$name" "$pid" "${pgid:-gone}" >&2
		tail -n 40 "$log_path" >&2 || true
		exit 1
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

# running_services: names whose pidfile points at a live process group.
running_services() {
	local svc pid pgid
	for svc in $SERVICES; do
		pid="$(read_pid "$svc" || true)"
		[ -n "$pid" ] || continue
		pgid="$(pgid_of "$pid" || true)"
		if [ -n "$pgid" ] && [ "$pgid" = "$pid" ]; then
			printf '%s\n' "$svc"
		fi
	done
	return 0
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

	[ -f "$REPO_ROOT/packages/overlay/dist/overlay.js" ] ||
		die "packages/overlay/dist/overlay.js is missing; run 'npm run build' at the repo root"

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

	printf '{"email":"%s","password":"%s","pbUrl":"http://127.0.0.1:%s","baseUrl":"http://127.0.0.1:%s"}\n' \
		"$ADMIN_EMAIL" "$pw" "$PB_PORT" "$CADDY_PORT" >"$STATE_DIR/creds.json"
	chmod 600 "$STATE_DIR/creds.json"

	start_service pocketbase "$pb" serve \
		--http "127.0.0.1:$PB_PORT" \
		--dir "$STATE_DIR/pb_data" \
		--migrationsDir "$STATE_DIR/pb_migrations" \
		--hooksDir "$STATE_DIR/pb_hooks"
	wait_for pocketbase "http://127.0.0.1:$PB_PORT/api/health" ||
		{ cmd_down || true; exit 1; }

	(
		cd "$REPO_ROOT/examples/demo-vue"
		start_service demo npx vite --host 127.0.0.1 --port "$DEMO_PORT" --strictPort
	)
	wait_for demo "http://127.0.0.1:$DEMO_PORT/" ||
		{ cmd_down || true; exit 1; }

	(
		export C11N_LISTEN=":$CADDY_PORT"
		export C11N_PB_ADDR="127.0.0.1:$PB_PORT"
		export C11N_OVERLAY_DIR="$REPO_ROOT/packages/overlay/dist"
		export C11N_UPSTREAM="http://127.0.0.1:$DEMO_PORT"
		export C11N_UPSTREAM_TLS="${C11N_UPSTREAM_TLS:-verify}"
		export XDG_DATA_HOME="$STATE_DIR/caddy/data"
		export XDG_CONFIG_HOME="$STATE_DIR/caddy/config"
		start_service caddy "$caddy" run \
			--config "$REPO_ROOT/deploy/Caddyfile" \
			--adapter caddyfile
	)
	wait_for caddy "http://127.0.0.1:$CADDY_PORT/__c11n/pb/api/health" ||
		{ cmd_down || true; exit 1; }

	log "caddy:      http://127.0.0.1:$CADDY_PORT (overlay + proxied PocketBase)"
	log "pocketbase: http://127.0.0.1:$PB_PORT (admin: /_/)"
	log "demo:       http://127.0.0.1:$DEMO_PORT"
	log "credentials: $STATE_DIR/creds.json (superuser $ADMIN_EMAIL)"
	log "stack is up"
}

# stop_service <name>: terminate the recorded process group, by pidfile only.
stop_service() {
	local name="$1" pidfile pid pgid i
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
	pgid="$(pgid_of "$pid" || true)"
	if [ "$pgid" != "$pid" ]; then
		log "warning: $name pid $pid is not a process-group leader (pgid ${pgid:-?}); leaving it alone"
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
	local svc pid pgid state
	for svc in $SERVICES; do
		pid="$(read_pid "$svc" || true)"
		pgid=""
		[ -n "$pid" ] && pgid="$(pgid_of "$pid" || true)"
		if [ -n "$pgid" ] && [ "$pgid" = "$pid" ]; then
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
