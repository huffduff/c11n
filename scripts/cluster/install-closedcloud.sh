#!/usr/bin/env bash
# scripts/cluster/install-closedcloud.sh - install c11n on a closedcloud test
# cluster, with a real upstream, and print the owner link.
#
# WHAT THIS DOES (Phase 5 task 5.5, run by whoever owns the cluster):
#   1. builds the three images IN the cluster's builder and reads the
#      repository/tag that `closedcloud build` returns
#        c11n-caddy        from deploy/caddy/Dockerfile (repo-root context)
#        c11n-pocketbase   from deploy/pocketbase
#        c11n-demo         from examples/demo-go-server/Dockerfile (test upstream)
#   2. applies the demo upstream (Deployment + Service "demo")
#   3. helm upgrade --install the chart against it, plain http behind Traefik
#   4. waits for both workloads (caddy Deployment, pocketbase StatefulSet)
#   5. prints the owner sign-in link from the pocketbase pod's log
#
# TWO WORKLOADS (ADR 0005, revised 2026-11-26): <fullname>-caddy (Deployment)
# and <fullname>-pocketbase (StatefulSet, one pod). The chart's NetworkPolicy is
# ON by default and k3s enforces it; the ingress namespace is kube-system, which
# is where Traefik runs on k3s. If you move the controller, either set
# NETWORK_POLICY=0 or the review URL 504s with both pods Ready.
#
# IMAGES ARE PINNED BY DIGEST when `closedcloud build` returns one, and the tag
# carries an epoch otherwise: a bare short sha is a moving tag, so a rebuild of
# the same commit used to be silently ignored (IfNotPresent).
#
# The PocketBase admin UI is NOT published unless ADMIN_INGRESS=1.
#
# WHAT IT DOES NOT DO:
#   * it never runs `closedcloud up`, `down` or `scale`: the cluster's lifetime
#     belongs to the operator (and this session's cluster is torn down when the
#     session ends).
#   * it never touches TLS: tls.mode=none + cookie.secure=false is deliberate,
#     because Traefik here serves plain http on port 80 and a Secure cookie
#     would be dropped by the browser on http://<address>.
#
# PREREQUISITES:
#   * KUBECONFIG is set (closedcloud up wrote it), kubectl and helm on PATH,
#     node on PATH (json parsing; jq is not assumed).
#   * a worker is running: closedcloud builds on worker-0.
#
# USAGE:
#   scripts/cluster/install-closedcloud.sh            # do it
#   DRY_RUN=1 scripts/cluster/install-closedcloud.sh  # print the commands only
#
# OVERRIDES (all optional):
#   RELEASE=c11n  NAMESPACE=default  HOST=c11n.closedcloud.test
#   OWNER_EMAIL=owner@c11n.test  TAG=<git short sha>-<epoch> by default
#   UPSTREAM_URL=http://demo:15174  SKIP_BUILD=1 (reuse TAG's images)
#   ADMIN_INGRESS=1 publishes the PocketBase admin UI on ADMIN_HOST. OFF by
#     default: the runbook's port-forward is the supported way in, and this
#     hostname has no TLS and no gate in front of it.
#   NETWORK_POLICY=0 disables the chart's NetworkPolicy (default: 1, on). Use it
#     only to prove a suspected policy problem (a 504 with both pods Ready), or
#     if `kubectl port-forward` turns out to be filtered by this cluster's CNI.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RELEASE="${RELEASE:-c11n}"
NAMESPACE="${NAMESPACE:-default}"
HOST="${HOST:-c11n.closedcloud.test}"
ADMIN_HOST="${ADMIN_HOST:-admin.${HOST}}"
OWNER_EMAIL="${OWNER_EMAIL:-owner@c11n.test}"
UPSTREAM_URL="${UPSTREAM_URL:-http://demo:15174}"
DRY_RUN="${DRY_RUN:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
ADMIN_INGRESS="${ADMIN_INGRESS:-0}"
NETWORK_POLICY="${NETWORK_POLICY:-1}"
# Helm's fullname: the release name when it already contains the chart name,
# <release>-c11n otherwise. Both workloads are named from it, so the log and
# rollout commands below cannot guess wrong for a RELEASE= override.
case "$RELEASE" in
	*c11n*) FULLNAME="$RELEASE" ;;
	*) FULLNAME="$RELEASE-c11n" ;;
esac
# A bare short sha is a MOVING tag for the same commit: rebuild the commit and
# the cluster keeps the old image under IfNotPresent. The epoch makes every
# build's tag unique, so a rebuild always deploys what was just built. (The
# digest from `closedcloud build` is preferred where it is available - see
# build_image.)
TAG="${TAG:-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)-$(date +%s)}"

# Build logs and JSON go here, outside the repo.
OUT="${OUT:-${TMPDIR:-/tmp}/c11n-cluster-install}"
JSON_GET="$REPO_ROOT/scripts/cluster/json-get.mjs"

log() { printf '%s\n' "$*" >&2; }
die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

# run <command...>: print it (always, so the log is a record) and run it unless
# DRY_RUN=1.
run() {
	printf '+ %s\n' "$*" >&2
	[ "$DRY_RUN" = 1 ] && return 0
	"$@"
}

[ -n "${KUBECONFIG:-}" ] || die "KUBECONFIG is not set; run 'closedcloud up' first (this script never does)"
command -v kubectl >/dev/null || die "kubectl is not on PATH"
command -v helm >/dev/null || die "helm is not on PATH"
command -v node >/dev/null || die "node is not on PATH (json-get.mjs needs it)"
[ -f "$REPO_ROOT/deploy/helm/c11n/Chart.yaml" ] || die "chart missing at deploy/helm/c11n"

mkdir -p "$OUT"
log "c11n install: release=$RELEASE namespace=$NAMESPACE host=$HOST tag=$TAG dry_run=$DRY_RUN"

# Set by build_image(): the repository and tag helm should deploy.
BUILD_REPO=""
BUILD_TAG=""

# build_image <name> <context> <dockerfile|""> <tag>
build_image() {
	local name="$1"
	local context="$2"
	local dockerfile="$3"
	local tag="$4"
	local json
	json="$OUT/$name.json"
	BUILD_REPO=""
	BUILD_TAG=""
	BUILD_DIGEST=""

	if [ "$DRY_RUN" = 1 ]; then
		if [ -n "$dockerfile" ]; then
			printf '+ closedcloud build %s -f %s -t %s:%s > %s\n' "$context" "$dockerfile" "$name" "$tag" "$json" >&2
		else
			printf '+ closedcloud build %s -t %s:%s > %s\n' "$context" "$name" "$tag" "$json" >&2
		fi
		BUILD_REPO="registry.closedcloud.internal/$name"
		BUILD_TAG="$tag"
		return 0
	fi

	if [ "$SKIP_BUILD" = 1 ] && [ -s "$json" ]; then
		log "reusing $json (SKIP_BUILD=1)"
	else
		if [ -n "$dockerfile" ]; then
			( cd "$REPO_ROOT" && closedcloud build "$context" -f "$dockerfile" -t "$name:$tag" ) >"$json"
		else
			( cd "$REPO_ROOT" && closedcloud build "$context" -t "$name:$tag" ) >"$json"
		fi
	fi

	BUILD_REPO="$(node "$JSON_GET" repository "$json")"
	BUILD_TAG="$(node "$JSON_GET" tag "$json")"
	# `closedcloud build` also returns `reference`: the digest-pinned name of the
	# image it just built (`repo:tag@sha256:...`). Deploying that digest is
	# strictly better than the tag - there is nothing left for the kubelet to
	# resolve, so a rebuilt image can never be masked by IfNotPresent or by a
	# stale registry tag. It is absent on an older closedcloud (json-get exits
	# non-zero), which falls back to the tag.
	BUILD_DIGEST="$(node "$JSON_GET" reference "$json" 2>/dev/null | sed -n 's/.*@\(sha256:[0-9a-f]\{64\}\)$/\1/p' || true)"
	log "$name -> $BUILD_REPO:$BUILD_TAG${BUILD_DIGEST:+ (digest $BUILD_DIGEST)}"
}

# ---- 1. images -------------------------------------------------------------
CADDY_REPO=""
CADDY_TAG=""
CADDY_DIGEST=""
PB_REPO=""
PB_TAG=""
PB_DIGEST=""
DEMO_REPO=""
DEMO_TAG=""
DEMO_DIGEST=""

build_image c11n-caddy . deploy/caddy/Dockerfile "$TAG"
CADDY_REPO="$BUILD_REPO"
CADDY_TAG="$BUILD_TAG"
CADDY_DIGEST="$BUILD_DIGEST"

build_image c11n-pocketbase deploy/pocketbase "" "$TAG"
PB_REPO="$BUILD_REPO"
PB_TAG="$BUILD_TAG"
PB_DIGEST="$BUILD_DIGEST"

build_image c11n-demo . examples/demo-go-server/Dockerfile "$TAG"
DEMO_REPO="$BUILD_REPO"
DEMO_TAG="$BUILD_TAG"
DEMO_DIGEST="$BUILD_DIGEST"

# The demo manifest takes one image reference; the digest is the whole point of
# preferring it, so use it when closedcloud returned one.
DEMO_IMAGE="$DEMO_REPO:$DEMO_TAG"
if [ -n "$DEMO_DIGEST" ]; then
	DEMO_IMAGE="$DEMO_REPO@$DEMO_DIGEST"
fi

# ---- 2. the demo upstream --------------------------------------------------
# The manifest carries __DEMO_IMAGE__ instead of a literal image so one file
# works for every build; substitution happens here, not in the file.
demo_manifest="$OUT/demo-upstream.yaml"
if [ "$DRY_RUN" = 1 ]; then
	printf '+ sed s|__DEMO_IMAGE__|%s| scripts/cluster/demo-upstream.yaml | kubectl apply -n %s -f -\n' \
		"$DEMO_IMAGE" "$NAMESPACE" >&2
else
	sed "s|__DEMO_IMAGE__|$DEMO_IMAGE|" "$REPO_ROOT/scripts/cluster/demo-upstream.yaml" >"$demo_manifest"
	run kubectl apply -n "$NAMESPACE" -f "$demo_manifest"
	run kubectl rollout status deploy/demo -n "$NAMESPACE" --timeout=180s
fi

# ---- 3. the chart ----------------------------------------------------------
# The storage class is spelled out (gp3 is this cluster's default) so the
# install does not depend on a cluster default existing.
#
# Images: repository always, plus EITHER the digest closedcloud returned (it
# wins over the tag in the chart: the rendered reference is repo@digest) or the
# tag. Never both, so what helm renders is unambiguous.
IMAGE_ARGS=(
	--set "caddy.image.repository=$CADDY_REPO"
	--set "pocketbase.image.repository=$PB_REPO"
)
if [ -n "$CADDY_DIGEST" ]; then
	IMAGE_ARGS+=(--set "caddy.image.digest=$CADDY_DIGEST")
else
	IMAGE_ARGS+=(--set "caddy.image.tag=$CADDY_TAG")
fi
if [ -n "$PB_DIGEST" ]; then
	IMAGE_ARGS+=(--set "pocketbase.image.digest=$PB_DIGEST")
else
	IMAGE_ARGS+=(--set "pocketbase.image.tag=$PB_TAG")
fi

# The admin UI is OFF unless asked for: it publishes the PocketBase superuser
# login with no TLS and no gate, and the runbook's port-forward is the
# supported way in.
ADMIN_ARGS=()
if [ "$ADMIN_INGRESS" = 1 ]; then
	ADMIN_ARGS+=(--set "adminIngress.enabled=true" --set "adminIngress.host=$ADMIN_HOST")
fi

# The NetworkPolicy is on by default and k3s enforces it (Traefik is in
# kube-system, which is the chart's default ingressNamespace). The escape hatch
# exists so a 504 from Traefik can be attributed to the policy in one command.
NETPOL_ARGS=()
if [ "$NETWORK_POLICY" != 1 ]; then
	NETPOL_ARGS+=(--set "networkPolicy.enabled=false")
fi

run helm upgrade --install "$RELEASE" "$REPO_ROOT/deploy/helm/c11n" \
	--namespace "$NAMESPACE" --create-namespace \
	--wait --timeout 10m \
	--set "host=$HOST" \
	--set "publicUrl=http://$HOST" \
	--set "upstream.url=$UPSTREAM_URL" \
	--set "upstream.tls=verify" \
	--set "owner.email=$OWNER_EMAIL" \
	--set "ingress.className=traefik" \
	--set "tls.mode=none" \
	--set "cookie.secure=false" \
	--set "persistence.storageClass=gp3" \
	--set "persistence.size=1Gi" \
	"${IMAGE_ARGS[@]}" \
	"${ADMIN_ARGS[@]}" \
	"${NETPOL_ARGS[@]}" \
	--set "resources.caddy.requests.cpu=10m" \
	--set "resources.caddy.requests.memory=32Mi" \
	--set "resources.caddy.limits.memory=128Mi" \
	--set "resources.pocketbase.requests.cpu=50m" \
	--set "resources.pocketbase.requests.memory=96Mi" \
	--set "resources.pocketbase.limits.memory=256Mi"

# ---- 4. wait for both workloads --------------------------------------------
# `helm --wait` already blocked until every Deployment and StatefulSet reports
# ready, but it reports "timed out waiting for the condition" without saying
# which one. These are idempotent, print the actual rollouts, and are what to
# look at first when the install took a long time.
run kubectl rollout status "deploy/$FULLNAME-caddy" -n "$NAMESPACE" --timeout=180s
run kubectl rollout status "statefulset/$FULLNAME-pocketbase" -n "$NAMESPACE" --timeout=300s

# ---- 5. the owner link -----------------------------------------------------
# The bootstrap runs on PocketBase's first HTTP request (its own readiness
# probe triggers it, and caddy's forward_auth does too), so by the time --wait
# returns the line is usually there. Give it a few seconds, because the log line
# is written by that first request, not at boot.
#
# statefulset/<name> logs the (only) pod; -c pocketbase because the pod name is
# the reliable selector and the container name is the documented one.
owner_link() {
	local i out
	for i in $(seq 1 30); do
		out="$(kubectl logs "statefulset/$FULLNAME-pocketbase" -n "$NAMESPACE" -c pocketbase 2>/dev/null | grep -m1 'c11n bootstrap: owner invite' || true)"
		if [ -n "$out" ]; then
			printf '%s\n' "$out"
			return 0
		fi
		sleep 1
	done
	return 1
}

printf '\n'
if [ "$DRY_RUN" = 1 ]; then
	printf 'DRY RUN: nothing was built or installed. Re-run without DRY_RUN=1.\n'
	printf '\nOn the cluster the owner link is:\n'
	printf "  kubectl logs statefulset/%s-pocketbase -n %s -c pocketbase | grep 'c11n bootstrap'\n" "$FULLNAME" "$NAMESPACE"
	printf '\nAnd the two port-forwards (different objects, so two commands):\n'
	printf "  kubectl port-forward deploy/%s-caddy -n %s 18080:8080\n" "$FULLNAME" "$NAMESPACE"
	printf "  kubectl port-forward svc/%s-pocketbase -n %s 18090:8090\n" "$FULLNAME" "$NAMESPACE"
	exit 0
fi

printf 'c11n installed: %s\n' "$RELEASE"
printf '  review URL:  http://%s/  (via Traefik at the cluster address)\n' "$HOST"
if [ "$ADMIN_INGRESS" = 1 ]; then
	printf '  admin UI:    http://%s/_/  (ADMIN_INGRESS=1; prefer a port-forward in real use)\n' "$ADMIN_HOST"
else
	printf '  admin UI:    not published (ADMIN_INGRESS=0); use the port-forward below\n'
fi
printf '  port-forward (review):     kubectl port-forward deploy/%s-caddy -n %s 18080:8080\n' "$FULLNAME" "$NAMESPACE"
printf '  port-forward (pocketbase): kubectl port-forward svc/%s-pocketbase -n %s 18090:8090\n' "$FULLNAME" "$NAMESPACE"
printf '  network policy: %s (ingressNamespace=kube-system)\n' "$([ "$NETWORK_POLICY" = 1 ] && printf 'ON (default)' || printf 'OFF (NETWORK_POLICY=0)')"
printf '\n'
if link_line="$(owner_link)"; then
	printf 'OWNER SIGN-IN LINK (single use, copy it now):\n'
	printf '  %s\n' "${link_line##*: }"
else
	printf 'No bootstrap line yet. Get it with:\n'
	printf "  kubectl logs statefulset/%s-pocketbase -n %s -c pocketbase | grep 'c11n bootstrap'\n" "$FULLNAME" "$NAMESPACE"
fi
printf '\nNext: scripts/cluster/e2e-against-ingress.md (run the Playwright suite against this install).\n'
