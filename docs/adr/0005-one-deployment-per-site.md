# ADR 0005: One k8s deployment per reviewed site; compose for dev only

**Status:** Accepted 2026-11-25 (Tom). Tom added three points:

- "K8s for final destination, so 1 container per service is fine."
- Cluster, ingress and domain: "All of this should be configurable."
- "One docker (k8s) hosted per site is fine. Compose just for dev work."

## Decision (accepted)

- Each reviewed site gets its own c11n deployment, hosted on Kubernetes.
  There is no multi-tenant routing.
- `deploy/docker-compose.yml` stays as the **dev** environment only. It is
  not a supported production path.

## Packaging (accepted)

- **Everything about the target environment is a Helm value, with nothing
  hardcoded.** That covers:
  - the hostname
  - `ingressClassName` and ingress annotations
  - TLS: a cert-manager `ClusterIssuer` name, an existing secret, or none
    (TLS terminated upstream)
  - the storage class and size
  - resources, node selectors and tolerations
  - the upstream URL and TLS mode
  - the bootstrap owner email
  - the optional S3 backup target
  - the optional SMTP settings

  The chart must work on k3s/Traefik and on ingress-nginx with no template
  changes.

- One Helm chart, `deploy/helm/c11n`. One release per reviewed site.
- **One pod, two containers (one per service):** `caddy` (with `replace-response` and the
  overlay bundle baked in) and `pocketbase` (with migrations and hooks
  baked in). They share the pod network, so Caddy reaches PocketBase on
  `localhost:8090`.
  - *Alternative:* a single image running both processes. That matches "one
    docker" literally, but needs a process supervisor in the container.
    Two containers is the k8s-native way to get the same "one deployable".
- `replicas: 1` and `strategy: Recreate`, because SQLite has a single
  writer. A PVC holds `pb_data`.
- Ingress with TLS terminates at the cluster. Caddy listens on plain HTTP
  inside the pod.
- Configuration comes from values and Secrets: upstream URL, public
  hostname, SMTP, bootstrap owner email, S3 backup target.
- The images are versioned together. The overlay is baked into the Caddy
  image, so there is no volume mount like compose uses.

## Consequences

- No shared state between sites, which keeps client data separate by
  construction.
- Upgrades mean a short outage (`Recreate`). That is acceptable for a review
  tool.
- The chart is verified on an ephemeral k3s cluster (closedcloud) before the
  dogfood deploy (plan Phase 5).
