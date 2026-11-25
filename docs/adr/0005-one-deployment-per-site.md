# ADR 0005: One k8s deployment per reviewed site; compose for dev only

**Status:** Accepted 2026-11-25 (Tom). The packaging detail below is
**Proposed**.

## Decision (accepted)

- Each reviewed site gets its own c11n deployment, hosted on Kubernetes.
  There is no multi-tenant routing.
- `deploy/docker-compose.yml` stays as the **dev** environment only. It is
  not a supported production path.

## Packaging (proposed, needs confirmation)

- One Helm chart, `deploy/helm/c11n`. One release per reviewed site.
- **One pod, two containers:** `caddy` (with `replace-response` and the
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
