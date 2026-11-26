# c11n on Kubernetes: runbook

One c11n release per reviewed site (ADR 0005). A release is **two workloads** —
a stateless `caddy` Deployment (proxy, overlay, sign-in page) and a
single-replica `pocketbase` StatefulSet (data, migrations, hooks, identity) —
joined by ClusterIP Services, fronted by one Ingress, and closed by a pair of
NetworkPolicies that are on by default.

This is the operating manual. The chart is `deploy/helm/c11n`; its `values.yaml`
documents every knob, and `templates/NOTES.txt` repeats the three commands you
need right after an install.

Throughout, `<ns>` is the namespace and `<host>` the review hostname, and the
commands use the names a release called `c11n` produces. Read the next section
before copying one.

## Object names (why they are `c11n-…`, not `<release>-c11n-…`)

Every object name comes from Helm's `fullname`, which is the **release name**
when that already contains the chart name, and `<release>-c11n` otherwise:

| Object | Release `c11n` | Release `c11n-acme` |
|---|---|---|
| caddy Deployment | `c11n-caddy` | `c11n-acme-caddy` |
| pocketbase StatefulSet (and its pod) | `c11n-pocketbase`, `c11n-pocketbase-0` | `c11n-acme-pocketbase`, `…-0` |
| Services | `c11n-caddy`, `c11n-pocketbase`, `c11n-pocketbase-headless` | `c11n-acme-caddy`, … |
| Ingress | `c11n` | `c11n-acme` |
| admin Ingress | `c11n-admin` | `c11n-acme-admin` |
| NetworkPolicies | `c11n-caddy`, `c11n-pocketbase` | `c11n-acme-caddy`, … |
| pb_data claim | `pb-data-c11n-pocketbase-0` | `pb-data-c11n-acme-pocketbase-0` |
| credentials Secret | `c11n-secrets` | `c11n-acme-secrets` |

Two naming rules worth knowing:

- The **Ingress** keeps the bare fullname (`c11n`), because it is the review
  host's front door and its name is the one people already type; its backend is
  the `c11n-caddy` Service.
- Every other object is component-suffixed. A release named `c11n` therefore has
  a Deployment `c11n-caddy` (there is no `c11n-c11n`). If your release is named
  differently, substitute that fullname; `helm template <release>
  deploy/helm/c11n --set host=… --set upstream.url=… --set owner.email=… | grep
  '^  name:'` prints the exact set.
- The **claim** name is derived by Kubernetes from the StatefulSet
  (`<template>-<sts>-<ordinal>`), not chosen by the chart: it changes if you
  rename the release. Adopting an existing volume after a rename needs a manual
  `kubectl patch pvc … volumeName: …` — see §10.

---

## 1. Install

Prerequisites: a cluster with an Ingress controller, a default (or named) RWO
block StorageClass, and the images. Images come from GHCR, built per tag by
`.github/workflows/release.yml`:

- `ghcr.io/huffduff/c11n-caddy:<version>`
- `ghcr.io/huffduff/c11n-pocketbase:<version>`

The chart defaults both repositories to GHCR and both tags to `appVersion`, so a
chart release installs the matching pair with no image values. A private GHCR
package needs `imagePullSecrets` set to a pull secret in the namespace.

**Bump `deploy/helm/c11n/Chart.yaml` before tagging.** `version` and
`appVersion` must both equal the tag without its `v` (`v1.2.3` → `1.2.3`):
`appVersion` is the image tag the chart installs, so a tag cut without the bump
would deploy the previous release's images. The `chart` job in
`.github/workflows/release.yml` fails the release (before any image is pushed)
when they disagree.

```sh
helm upgrade --install c11n deploy/helm/c11n \
  --namespace <ns> --create-namespace \
  --set host=review.example.com \
  --set upstream.url=https://staging.example.com \
  --set owner.email=you@example.com \
  --set ingress.className=traefik \
  --set tls.mode=certManager \
  --set tls.issuer=letsencrypt-prod \
  --set persistence.storageClass=gp3 \
  --set persistence.size=10Gi \
  --wait --timeout 10m
```

It creates a `c11n-caddy` Deployment and a `c11n-pocketbase` StatefulSet whose
claim (`pb-data-c11n-pocketbase-0`) is created empty on first boot. The
NetworkPolicy is on: leave `networkPolicy.ingressNamespace` at `kube-system` on
k3s/Traefik, set it to `ingress-nginx` on ingress-nginx, or the review host
answers 504 (see §9).

Three values are required and the render fails without them (by design, with a
message naming the value): `host`, `upstream.url`, `owner.email`.

Where the environment differs, it is a value — nothing is hardcoded:

| What | Values |
|---|---|
| hostname / origin in invite links | `host`, `publicUrl` (default `https://<host>`) |
| ingress class and extra annotations | `ingress.className`, `ingress.annotations` |
| TLS | `tls.mode`: `certManager` (+`tls.issuer`), `existingSecret` (+`tls.secretName`), `none` |
| admin UI TLS | `adminIngress.tls.secretName` (default `<adminHost>-tls`, never the review host's Secret) |
| storage | `persistence.storageClass` (empty = cluster default), `persistence.size` |
| sizing / placement | `resources.caddy`, `resources.pocketbase`, `nodeSelector`, `tolerations`, `affinity` |
| the reviewed site | `upstream.url`, `upstream.tls` (`verify`\|`insecure`) |
| identity | `owner.email`, `session.ttlDays`, `invite.ttlHours`, `invite.ratePerHour`, `cookie.secure` |
| backups | `backup.cron`, `backup.keep`, `backup.s3.*` |
| mail (inert until post-MVP) | `smtp.*` |
| admin UI exposure | `adminIngress.enabled` (default false), `adminIngress.host` |
| network policy | `networkPolicy.enabled` (default **true**), `networkPolicy.ingressNamespace` (default `kube-system`), `networkPolicy.ingressPodSelector`, `networkPolicy.additionalAllowedCidrs` |
| caddy scaling | `caddy.replicas` (default 1), `caddy.pdb.enabled` (default false) |
| per-component sizing / placement | `caddy.resources`, `caddy.nodeSelector`, `caddy.tolerations`, `caddy.affinity` and the `pocketbase.*` equivalents (empty = the top-level value) |

`sizing / placement` in the row above is the top-level default for both pods;
the `caddy.*` / `pocketbase.*` blocks override it for one of them.

On a disposable test cluster (closedcloud), `scripts/cluster/install-closedcloud.sh`
does the whole install, including building the images in-cluster. It pins the
images by digest (`closedcloud build`'s `reference`) so a rebuild of the same
commit is never masked by `IfNotPresent`, and it leaves the admin Ingress **off**
(`ADMIN_INGRESS=1` turns it on) — the port-forward below is the default way in.

## 2. Getting the owner link (the only way in)

There is no password, no sign-up and no admin UI on the review host. The first
owner is created on PocketBase's **first HTTP request** (its own readiness probe
triggers it, and so does any gated page view through caddy), and its single-use
sign-in link is printed to the **pocketbase container's stdout** — not to the
database.

```sh
kubectl logs statefulset/c11n-pocketbase -n <ns> -c pocketbase | grep 'c11n bootstrap'
```

That prints something like:

```
c11n bootstrap: owner invite for you@example.com (single use, expires in 72h): https://review.example.com/__c11n/auth/#t=…
```

Copy the whole URL **now**: the raw token exists only in that line (the database
stores its sha256), it is single use, and it expires after `invite.ttlHours`
(72 h default).

- Pod already restarted? `kubectl logs c11n-pocketbase-0 -n <ns> -c pocketbase --previous`.
- Line gone for good? Ask an existing owner/team member for a fresh link
  (overlay → Invite), or mint one yourself — see §8.
- Nothing there yet? The line appears on the first request. The readiness probe
  makes one within seconds; if the pod is not ready, see §9.

Open the link and click **Continue to review**. The token stays in the URL
fragment, so a link preview or an email scanner cannot spend it.

## 3. Inviting people

Owners and team members invite from the overlay's sidebar (**Invite**). The MVP
is copy-the-link: the overlay shows a URL you pass on through Slack or email.
There is no outbound mail yet, and `smtp.*` values are wired into the environment
but nothing reads them (ADR 0006, MVP scope).

Invites are single use and last `invite.ttlHours`; `invite.ratePerHour` caps how
many one person can mint per hour (default 30). Unknown emails get the same
answer as known ones, so the form reveals nothing about who is invited.

## 4. Upgrade

The two workloads are upgraded independently, and that is the point of the
split: **a caddy-only change rolls the proxy with no database restart**, and a
pocketbase change restarts the database only, with caddy still serving the
sign-in page (and 401/502 for gated routes) while it boots.

| What changed | What rolls | Outage |
|---|---|---|
| `caddy.*`, `upstream.*`, `host`, `publicUrl`, `cookie.secure` | the caddy Deployment only (its `checksum/config` moves) | none: `maxUnavailable: 0` adds the new pod first, and readiness only needs the ungated sign-in page |
| `owner.*`, `session.*`, `invite.*`, `backup.*`, `smtp.*`, `pocketbase.image` | the pocketbase StatefulSet only | **seconds to a couple of minutes**: the pod is deleted (a StatefulSet deletes before it creates), migrations run at boot, readiness returns. Gated pages get 401/502 meanwhile; the sign-in page itself still loads |
| `resources` / `nodeSelector` / `tolerations` / `affinity` | whichever pod spec changed | as above for that pod |

```sh
# 1. new images exist (a v* tag builds both)
helm upgrade c11n deploy/helm/c11n -n <ns> --reuse-values \
  --set caddy.image.tag=1.2.3 --set pocketbase.image.tag=1.2.3 \
  --wait --timeout 10m
```

- `--reuse-values` keeps the site's configuration; only the tags change. (A
  fresh `-f site-values.yaml` is better practice if you keep one per site.)
- PocketBase migrations are forward-only and run at boot; the startup probe
  allows ~2 minutes for them. **Back up before an upgrade** (§5) if the release
  notes mention a migration.
- Set only the tag you are changing if you want to roll one workload: a
  `--set pocketbase.image.tag=` with no caddy change leaves caddy running.
- Verify: `curl -sI https://<host>/__c11n/auth/` → 200; `https://<host>/`
  redirects to the sign-in page when signed out; a signed-in page loads the
  overlay.
- Roll back only with a compatible older image AND a database backup: an older
  image against a newer schema is not supported by PocketBase. Rolling caddy
  back alone is safe at any time (it holds no state).
- The caddy PDB (`caddy.pdb.enabled`) only matters with `caddy.replicas` ≥ 2;
  leaving it on at 1 replica blocks node drains.

## 5. Backup and restore

### 5.1 Scheduled backups to S3 (optional, recommended)

PocketBase's own backup machinery, configured from values and applied by
`pb_hooks/settings.pb.js` on the first request:

```yaml
backup:
  cron: "0 3 * * *"      # standard 5-field cron; empty = off (the default)
  keep: 14               # how many zips stay in the bucket
  s3:
    endpoint: https://s3.eu-central-1.amazonaws.com   # MinIO: https://minio:9000
    bucket: c11n-review-example
    region: eu-central-1
    accessKey: …
    secretKey: …
    forcePathStyle: false   # true for MinIO and most non-AWS S3
```

- The access key and secret land in a chart-managed Secret, not in the pod spec;
  the hook never logs either (only bucket/endpoint/region/cron/keep).
- These values are then the source of truth: the hook re-applies them on every
  pod start, so a change made on the admin UI's Backups page is **reverted by
  the next restart**. Change the values and `helm upgrade`.
- Each run uploads a zip of `pb_data` (database + uploads) and prunes to `keep`.
- What this is **not**: it is not a restore, and it does not back up the PVC's
  other files. It is also inside the same failure domain as the pod's credentials
  — keep a second, independent copy of critical sites (bucket versioning, or a
  `kubectl cp` of a manual backup, see 5.2).

Check it worked: `kubectl exec statefulset/c11n-pocketbase -c pocketbase -- ls /pb/pb_data/backups`
(local copies are kept too) and look in the bucket. Failures show in the
pocketbase log (`kubectl logs … | grep -i backup`).

The claim does **not** grow when `persistence.size` changes: a StatefulSet's
`volumeClaimTemplates` is only read when the claim is created. To grow it, patch
the claim for a StorageClass that allows expansion:

```sh
kubectl patch pvc pb-data-c11n-pocketbase-0 -n <ns> -p '{"spec":{"resources":{"requests":{"storage":"20Gi"}}}}'
```

and leave `persistence.size` in step so a later re-create matches.

### 5.2 A manual backup (admin UI, no S3 needed)

```sh
kubectl port-forward svc/c11n-pocketbase -n <ns> 8090:8090
# open http://127.0.0.1:8090/_/  (superuser account, see §8)
# Settings → Backups → "Create backup", then download the zip
```

Or over the API, which is what the CI check does (`scripts/check-backups.mjs`):

```sh
TOKEN=$(curl -s -X POST http://127.0.0.1:8090/api/collections/_superusers/auth-with-password \
  -H 'content-type: application/json' \
  -d '{"identity":"su@example.com","password":"…"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s -X POST http://127.0.0.1:8090/api/backups -H "authorization: $TOKEN"
curl -s http://127.0.0.1:8090/api/backups -H "authorization: $TOKEN"
```

### 5.3 Restore

A restore **replaces all of `pb_data`** with the zip's contents and restarts
PocketBase. Anyone signed in with a session minted after the backup will find it
gone; that is expected.

1. Back up the current state first (5.2) — a restore is not undoable.
2. Put the zip where PocketBase can see it. The two practical routes:
   - **Admin UI / API**: upload the zip in Settings → Backups (or
     `POST /api/backups/upload`), then click **Restore** (or
     `POST /api/backups/<key>/restore`).
   - **Copy the file in**: `kubectl cp ./pb_backup_….zip <ns>/<pod>:/pb/pb_data/backups/ -c pocketbase`
     (the pod runs as uid 65532; the directory is writable by it).
3. Restore. It is asynchronous: PocketBase unpacks the zip and re-execs. Watch
   for restarts and a second "Server started" line:
   `kubectl logs -f statefulset/c11n-pocketbase -c pocketbase`.
4. Verify: sign in with the owner link from that backup (it was single use, so
   mint a new one — §8), and check the overlays' comments are the expected set.
5. A restore of a backup taken on a **different image version** runs that
   version's migrations on the next boot, exactly like an upgrade.

## 6. Rotating secrets

| Secret | Where it lives | How to rotate |
|---|---|---|
| S3 access key / secret | chart Secret `c11n-secrets` (from values) | change `backup.s3.accessKey/secretKey`, `helm upgrade --reuse-values --set …`; the hook re-applies settings on the next pod start (it is a one-shot per process) |
| PocketBase superuser password | the database | admin UI → superuser → change password, or `kubectl exec … -- /pb/pocketbase superuser update <email> <password> --dir=/pb/pb_data` |
| SMTP password | chart Secret (inert today) | change the value; nothing reads it yet |
| Session cookies | — | rotate `session.ttlDays` (shorter sessions) and restart; existing cookies keep their original expiry. There is no server-side session revocation: a stolen cookie is valid until it expires. Removing the user does invalidate it (the gate re-reads the user). |
| Invite links | database rows | they are single use and expire; delete unused rows to revoke them |

Rotating a chart value is a `helm upgrade`, and what it restarts depends on
which pod consumes it: caddy's values roll the proxy with no outage; PocketBase's
values (and the S3 credentials) restart the one pocketbase pod — a short outage
of the gated routes, with the sign-in page still served. See §4.

## 7. Reaching the PocketBase admin UI

The admin UI is **not** on the review host: Caddy answers 404 for
`/__c11n/pb/_/*` on purpose. Use a port-forward to the pocketbase Service:

```sh
kubectl port-forward svc/c11n-pocketbase -n <ns> 8090:8090
# http://127.0.0.1:8090/_/
```

`adminIngress.enabled=true` exists for operators who need it published, but it
puts the superuser login on a real hostname with no gate in front of it. If you
use it, put TLS, an IP allowlist or an auth proxy in front, and turn it off
when you are done. Its Ingress gets its own TLS Secret (`<adminHost>-tls` by
default): cert-manager keeps one certificate per Secret, so it must not share
the review host's. It is also the **only** thing that makes the chart open 8090
to the ingress controller (see §9).

PocketBase has a ClusterIP Service now, but internal-only is a *network* fact,
not a Service-type one: subject to the CNI, any pod in the cluster can dial
`c11n-pocketbase.<ns>.svc:8090` and use the PocketBase API. That is exactly what
the pocketbase NetworkPolicy prevents — it admits 8090 from caddy pods only
(plus the ingress controller when `adminIngress.enabled`).

Superuser accounts are separate from c11n users: the owner and reviewers do not
have admin UI accounts.

## 8. The owner lost their link / there is no owner

There is no email channel. An owner or team member can mint a fresh link from
the overlay (**Invite** → same email → copy the link).

If nobody can sign in (or the owner account is gone), mint one from the pod:

```sh
kubectl exec statefulset/c11n-pocketbase -n <ns> -c pocketbase -- \
  /pb/pocketbase superuser upsert admin@example.com 'a-long-password' --dir=/pb/pb_data
```

then invite from the admin API:

```sh
TOKEN=$(curl -s -X POST http://127.0.0.1:8090/api/collections/_superusers/auth-with-password \
  -H 'content-type: application/json' \
  -d '{"identity":"admin@example.com","password":"a-long-password"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s -X POST http://127.0.0.1:8090/api/c11n/invite \
  -H "authorization: $TOKEN" -H 'content-type: application/json' \
  -d '{"email":"you@example.com","role":"owner"}'
```

The response carries `link` — open it and click Continue.

## 9. Troubleshooting

### Sign-in loops, or every page bounces to `/__c11n/auth/`

Symptom: the sign-in page works, the claim appears to succeed, and the next page
sends you straight back.

1. **Plain http with a Secure cookie.** `cookie.secure=true` (the default) on a
   deployment whose public origin is plain http means the browser stores nothing:
   every request arrives anonymous, so every page redirects to sign-in. Check
   `cookie.secure` and the scheme in `publicUrl`. Browsers exempt `localhost` and
   `127.0.0.1`; a real hostname on http has no such exemption.
2. **`publicUrl` does not match the origin users visit.** Invite links are
   absolute; a link minted for `https://a.example.com` used on
   `http://b.example.com` has a mismatched `Origin` and the claim is refused
   (that is the CSRF check doing its job).
3. **The cookie is dropped somewhere in between.** A proxy or CDN in front of the
   Ingress that strips `Set-Cookie`, or terminates TLS and does not forward
   `X-Forwarded-Proto`, produces the same loop.
4. **Stale page from cache.** Gated HTML is `private, no-store`; if a page is
   being served from a cache anyway, that cache is misconfigured.

Diagnose from inside each pod (they are separate now, so `kubectl exec` names
the workload it belongs to):

```sh
kubectl exec deploy/c11n-caddy -c caddy -- wget -qO- --header 'Host: <host>' http://127.0.0.1:8080/__c11n/auth/
kubectl exec statefulset/c11n-pocketbase -c pocketbase -- wget -qO- http://127.0.0.1:8090/api/health
# and the hop between them, which is the one a NetworkPolicy can break:
kubectl exec deploy/c11n-caddy -c caddy -- wget -qO- http://c11n-pocketbase:8090/api/health
kubectl logs statefulset/c11n-pocketbase -c pocketbase | tail -50   # claim refusals are logged
```

### 504 from the ingress, or a timeout, with both pods Ready

The classic NetworkPolicy failure after the split: caddy is healthy (its probes
are local) and pocketbase is healthy, but the ingress controller cannot reach
caddy, so every request times out or 504s.

1. **Wrong ingress namespace.** `networkPolicy.ingressNamespace` must be the
   namespace the controller's *pods* run in — `kube-system` on k3s/Traefik (the
   chart's default), `ingress-nginx` on ingress-nginx. Check with
   `kubectl get pods -A | grep -Ei 'traefik|ingress'` and fix the value.
2. **Narrowed pod selector.** If you set `networkPolicy.ingressPodSelector`,
   its labels must match the controller's pods (`kubectl get pods -n <ns>
   --show-labels`).
3. **The controller is outside the cluster** (a load balancer talking to node
   ports): add its CIDR to `networkPolicy.additionalAllowedCidrs`.
4. Prove it is the policy: `helm upgrade … --reuse-values --set
   networkPolicy.enabled=false`, retry, and re-enable once the source is known.
   The policies are ingress-only, so DNS and the upstream are never affected.
5. A CNI without a policy controller ignores the object entirely — the site
   then works and the policy protects nothing. Check the CNI, not the chart.

`kubectl port-forward` traffic is usually outside the policy (it is SNAT'd by
the kubelet), which is why the NOTES.txt port-forwards normally keep working
with the policy on. That is CNI-dependent: if a port-forward hangs, add the node
subnet to `additionalAllowedCidrs` or disable the policy.

### 502/503 from the ingress

Caddy is up but PocketBase is not (the gate is a forward_auth through it), or
the upstream is unreachable. Check each workload's readiness, then:

```sh
kubectl logs deploy/c11n-caddy --prefix
kubectl logs statefulset/c11n-pocketbase -c pocketbase | tail -50
kubectl exec deploy/c11n-caddy -c caddy -- wget -qO- --spider <upstream.url>
```

A 502 that starts the moment a pocketbase upgrade begins and clears when its pod
is Ready is the expected window (§4), not a fault.

### Upstream TLS errors

`upstream.tls=verify` is the default and the right answer for a real certificate.
For an https upstream with a self-signed certificate, set `upstream.tls=insecure`
— accepting that the proxy no longer authenticates the reviewed site. Caddy
refuses `insecure` on a plain-http upstream, and the chart fails the render with
that message rather than shipping a config that cannot load.

### Pod stuck in startup / restarts at boot

On a fresh database the first boot runs every migration, which takes longer than
the liveness probe's first window — that is why the startupProbe allows ~2
minutes. If it still restarts, read the previous container's log
(`kubectl logs … --previous`): a failed migration leaves a clear SQL error. A
full PVC (`kubectl exec … -- df -h /pb/pb_data`) also fails migrations.

### PVC pending

Normal on a `WaitForFirstConsumer` StorageClass: the claim binds when the pod
schedules. `kubectl describe pvc pb-data-c11n-pocketbase-0 -n <ns>` and
`kubectl describe pod c11n-pocketbase-0 -n <ns>` say which constraint failed
(cpu/memory, nodeSelector, volume zone). Never use NFS for this volume: SQLite
on a network filesystem corrupts.

## 10. Uninstall, and reinstall over the retained data

```sh
helm uninstall c11n -n <ns>
```

What happens to the data: the StatefulSet sets
`persistentVolumeClaimRetentionPolicy: {whenDeleted: Retain, whenScaled: Retain}`,
so **deleting the StatefulSet (which the uninstall does) leaves the claim
`pb-data-c11n-pocketbase-0` and its volume behind.** Nothing has to be annotated
`helm.sh/resource-policy: keep` any more — the retention policy is a property of
the workload, and it also covers `kubectl delete statefulset`, which the old
annotation did not.

Reinstall with the SAME release name and namespace. The StatefulSet is created
again with the same metadata name, so it looks for the same claim; Kubernetes
adopts it, and the site comes back exactly as it was (the migrations are already
at the release's version):

```sh
helm upgrade --install c11n deploy/helm/c11n -n <ns> -f site-values.yaml --wait --timeout 10m
```

- `--take-ownership` is no longer needed for the data: the **PVC is not a Helm
  object** (it is created by the StatefulSet), so there are no release ownership
  annotations on it to fight over. You may still need the flag for other
  objects if you are adopting a namespace that already has them.
- A different `persistence.storageClass` is ignored on reinstall: the existing
  claim keeps the class it was created with.
- Renaming the release renames the StatefulSet, hence the claim name, and the
  new pod starts on an **empty** volume. Do not "fix" that by deleting the old
  claim: rename the PVC's `spec.volumeName` onto a fresh claim, or restore from
  a backup (§5.3).

To delete everything, including the reviewed site's data:

```sh
helm uninstall c11n -n <ns>
kubectl delete pvc pb-data-c11n-pocketbase-0 -n <ns>
# the StorageClass's reclaim policy then decides the volume's fate (Delete on
# most dynamic provisioners; `kubectl get pv` to confirm nothing is orphaned)
```

The chart's Secret (`c11n-secrets`) goes with the release, as do both
workloads, the three Services, the Ingresses and the NetworkPolicies. Take a
backup first if the data matters — this is the step with no undo.

### Migrating from the pre-split layout (one pod, PVC `c11n-pb-data`)

Releases installed before the split have a single Deployment and a claim called
`c11n-pb-data`. The split's claim is `pb-data-c11n-pocketbase-0`, so an
`helm upgrade` starts PocketBase on an **empty** database: there is nothing that
copies data across, by design (the chart never mutates a volume).

For a real site, copy `pb_data` before switching:

```sh
# 1. stop the old pod so nothing writes during the copy
kubectl scale deploy/c11n --replicas=0 -n <ns>
# 2. install the new layout, then stop its pod too (it would start empty)
helm upgrade c11n deploy/helm/c11n -n <ns> --reuse-values
kubectl scale statefulset/c11n-pocketbase --replicas=0 -n <ns>
# 3. run a one-off pod that mounts BOTH claims (c11n-pb-data and
#    pb-data-c11n-pocketbase-0 at /old and /new) and `cp -a /old/. /new/`
#    as uid 65532. The chart has no value for this on purpose: it is a manual,
#    reviewed step, and the helper pod must be deleted afterwards.
# 4. delete the old Deployment and its claim, then bring pocketbase back
kubectl delete deploy/c11n -n <ns>
kubectl delete pvc c11n-pb-data -n <ns>
kubectl scale statefulset/c11n-pocketbase --replicas=1 -n <ns>
```

On a disposable cluster the honest shortcut is a fresh install and a new owner
link: there is no production c11n install yet.
