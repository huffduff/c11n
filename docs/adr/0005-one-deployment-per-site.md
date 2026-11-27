# ADR 0005: One k8s deployment per reviewed site; compose for dev only

**Status:** Accepted 2026-11-25 (Tom); **revised 2026-11-26 (Tom)** — see
"Revision" below. Tom's original three points:

- "K8s for final destination, so 1 container per service is fine."
- Cluster, ingress and domain: "All of this should be configurable."
- "One docker (k8s) hosted per site is fine. Compose just for dev work."

## Decision (accepted)

- Each reviewed site gets its own c11n deployment, hosted on Kubernetes.
  There is no multi-tenant routing.
- `deploy/docker-compose.yml` stays as the **dev** environment only. It is
  not a supported production path.

## Revision 2026-11-26 (Tom)

**Revised 2026-11-26 (Tom): Caddy and PocketBase run as separate workloads
(Deployment + single-replica StatefulSet) with NetworkPolicy on by default.**

Tom's reasoning, in his words: *"sharing a pod isn't k8s best practice, and
there's no immediate need for it."*

The original packaging (one pod, two containers) is kept below as the
**superseded** position, with the reasons it was dropped.

## Packaging (revised 2026-11-26)

- **Everything about the target environment is a Helm value, with nothing
  hardcoded.** That covers:
  - the hostname
  - `ingressClassName` and ingress annotations
  - TLS: a cert-manager `ClusterIssuer` name, an existing secret, or none
    (TLS terminated upstream)
  - the storage class and size
  - resources, node selectors, tolerations and affinity — per component,
    defaulting to a top-level value
  - the upstream URL and TLS mode
  - the bootstrap owner email
  - the optional S3 backup target
  - the optional SMTP settings
  - the caddy replica count (and its optional PodDisruptionBudget)

  The chart must work on k3s/Traefik and on ingress-nginx with no template
  changes.

- One Helm chart, `deploy/helm/c11n`. One release per reviewed site.
- **Two workloads, one per service:**
  - `caddy` is a **Deployment** (`<fullname>-caddy`), stateless: the overlay
    bundle and the sign-in page are baked into the image, and the pod's only
    writable state is an autosaved config and a temp dir (emptyDirs). It can
    therefore scale (`caddy.replicas`, default 1) and roll
    (`RollingUpdate`, `maxUnavailable: 0`, `maxSurge: 1`) without an outage.
    It reaches PocketBase at `C11N_PB_ADDR=<fullname>-pocketbase:8090`.
  - `pocketbase` is a **StatefulSet** (`<fullname>-pocketbase`) with
    `replicas: 1` **hardcoded** and `podManagementPolicy: OrderedReady`. Its
    `volumeClaimTemplates` holds `pb_data` (claim
    `pb-data-<fullname>-pocketbase-0`), with
    `persistentVolumeClaimRetentionPolicy: {whenDeleted: Retain, whenScaled:
    Retain}` so deleting the workload never deletes the reviewed site's data.
    A headless Service gives it stable pod DNS.
  - The two are joined by ClusterIP Services: `<fullname>-caddy` (the Ingress
    backend) and `<fullname>-pocketbase` (internal; the admin Ingress's backend
    when that opt-in is on).
- **NetworkPolicy is on by default.** PocketBase's 8090 accepts connections
  only from caddy pods (and from the ingress controller's namespace when the
  admin Ingress publishes it); caddy's 8080 accepts only the ingress
  controller's namespace (plus any operator-supplied pod selector or CIDRs).
  Egress is deliberately unrestricted: caddy proxies to an arbitrary upstream
  and PocketBase uploads to an arbitrary S3 endpoint.
- Ingress with TLS terminates at the cluster. Caddy listens on plain HTTP
  inside its pod.
- Configuration comes from values and Secrets: upstream URL, public
  hostname, SMTP, bootstrap owner email, S3 backup target.
- The images are versioned together. The overlay is baked into the Caddy
  image, so there is no volume mount like compose uses.

### Superseded: one pod, two containers (2026-11-25 → 2026-11-26)

What the chart did until this revision, kept for the record. It was not wrong
for a single-site toy, but Tom's call is that it is not how a k8s workload
should be shaped:

- **One pod, two containers:** `caddy` and `pocketbase` shared the pod network,
  so Caddy reached PocketBase on `localhost:8090`.
- `replicas: 1` and `strategy: Recreate` on the single Deployment, because
  SQLite has a single writer, so every upgrade — even an overlay-only change —
  was a full outage of the site. A standalone PVC annotated
  `helm.sh/resource-policy: keep` held `pb_data`.
- One Service on 8080, gaining an 8090 port only when the admin Ingress was
  enabled.

Why it was dropped:

- Sharing a pod couples two processes' lifecycles: a proxy change restarted the
  database, and any crash of either container restarted both (the pod's
  restartPolicy is per pod, not per container).
- It gave up the stateless/scalable half: caddy could not be replicated or
  rolled without taking PocketBase down with it.
- A NetworkPolicy can only select pods, so "the proxy may talk to 8090 and the
  ingress controller may not" was inexpressible while both shared a label set —
  port 8090 was effectively cluster-wide reachable.

## Consequences

- No shared state between sites, which keeps client data separate by
  construction.
- Upgrades are now asymmetric, and that is the gain: a caddy change rolls with
  no outage; a pocketbase change restarts the database only (caddy keeps
  serving the sign-in page, and gated routes 401/502 briefly). This replaces
  "every upgrade is a short outage".
- The chart is larger (two workload templates, three Services, two
  NetworkPolicies) and has one more moving part to get wrong: the
  `networkPolicy.ingressNamespace` must match where the ingress controller
  runs, or the site 504s while every pod is Ready. That is documented in the
  runbook and is exactly what `networkPolicy.enabled` is there to diagnose.
- Enforcement is CNI-dependent; on a CNI without a policy controller the
  policies are documentation, not a control.
- The chart is verified on an ephemeral k3s cluster (closedcloud) before the
  dogfood deploy (plan Phase 5).
