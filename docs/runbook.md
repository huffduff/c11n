# c11n on Kubernetes: runbook

One c11n release per reviewed site (ADR 0005). A release is one pod with two
containers — `caddy` (proxy, overlay, sign-in page) and `pocketbase` (data,
migrations, hooks, identity) — plus a PVC, a Service and an Ingress.

This is the operating manual. The chart is `deploy/helm/c11n`; its `values.yaml`
documents every knob, and `templates/NOTES.txt` repeats the three commands you
need right after an install.

Throughout: `<rel>` is the Helm release name (say `c11n`), `<ns>` its namespace,
`<host>` the review hostname.

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

```sh
helm upgrade --install <rel> deploy/helm/c11n \
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

Three values are required and the render fails without them (by design, with a
message naming the value): `host`, `upstream.url`, `owner.email`.

Where the environment differs, it is a value — nothing is hardcoded:

| What | Values |
|---|---|
| hostname / origin in invite links | `host`, `publicUrl` (default `https://<host>`) |
| ingress class and extra annotations | `ingress.className`, `ingress.annotations` |
| TLS | `tls.mode`: `certManager` (+`tls.issuer`), `existingSecret` (+`tls.secretName`), `none` |
| storage | `persistence.storageClass` (empty = cluster default), `persistence.size` |
| sizing / placement | `resources.caddy`, `resources.pocketbase`, `nodeSelector`, `tolerations`, `affinity` |
| the reviewed site | `upstream.url`, `upstream.tls` (`verify`\|`insecure`) |
| identity | `owner.email`, `session.ttlDays`, `invite.ttlHours`, `invite.ratePerHour`, `cookie.secure` |
| backups | `backup.cron`, `backup.keep`, `backup.s3.*` |
| mail (inert until post-MVP) | `smtp.*` |
| admin UI exposure | `adminIngress.enabled` (default false), `adminIngress.host` |

On a disposable test cluster (closedcloud), `scripts/cluster/install-closedcloud.sh`
does the whole install, including building the images in-cluster.

## 2. Getting the owner link (the only way in)

There is no password, no sign-up and no admin UI on the review host. The first
owner is created on PocketBase's **first HTTP request** (a readiness probe
triggers it), and its single-use sign-in link is printed to the **pocketbase
container's stdout** — not to the database.

```sh
kubectl logs deploy/<rel> -n <ns> -c pocketbase | grep 'c11n bootstrap'
```

That prints something like:

```
c11n bootstrap: owner invite for you@example.com (single use, expires in 72h): https://review.example.com/__c11n/auth/#t=…
```

Copy the whole URL **now**: the raw token exists only in that line (the database
stores its sha256), it is single use, and it expires after `invite.ttlHours`
(72 h default).

- Pod already restarted? `kubectl logs deploy/<rel> -c pocketbase --previous`.
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

`strategy: Recreate` and `replicas: 1` are hardcoded: SQLite has one writer, so
the old pod must stop before the new one opens the database. **An upgrade is a
short outage** (tens of seconds: image pull excluded, the pod restarts, migrations
run, readiness returns). Announce it for a client-facing review site.

```sh
# 1. new images exist (a v* tag builds both)
helm upgrade <rel> deploy/helm/c11n -n <ns> --reuse-values \
  --set caddy.image.tag=1.2.3 --set pocketbase.image.tag=1.2.3 \
  --wait --timeout 10m
```

- `--reuse-values` keeps the site's configuration; only the tags change. (A
  fresh `-f site-values.yaml` is better practice if you keep one per site.)
- Migrations run at boot; the startup probe allows ~2 minutes for them.
  PocketBase migrations are forward-only: **back up before an upgrade** (§5) if
  the release notes mention a migration.
- Verify: the probe path, a sign-in, and that the overlay loads:
  `curl -sI https://<host>/__c11n/auth/` → 200; `https://<host>/` redirects to
  the sign-in page when signed out.
- Roll back only with a compatible older image AND a database backup: an older
  image against a newer schema is not supported by PocketBase.

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
- Each run uploads a zip of `pb_data` (database + uploads) and prunes to `keep`.
- What this is **not**: it is not a restore, and it does not back up the PVC's
  other files. It is also inside the same failure domain as the pod's credentials
  — keep a second, independent copy of critical sites (bucket versioning, or a
  `kubectl cp` of a manual backup, see 5.2).

Check it worked: `kubectl exec deploy/<rel> -c pocketbase -- ls /pb/pb_data/backups`
(local copies are kept too) and look in the bucket. Failures show in the
pocketbase log (`kubectl logs … | grep -i backup`).

### 5.2 A manual backup (admin UI, no S3 needed)

```sh
kubectl port-forward deploy/<rel> -n <ns> 8090:8090
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
   `kubectl logs -f deploy/<rel> -c pocketbase`.
4. Verify: sign in with the owner link from that backup (it was single use, so
   mint a new one — §8), and check the overlays' comments are the expected set.
5. A restore of a backup taken on a **different image version** runs that
   version's migrations on the next boot, exactly like an upgrade.

## 6. Rotating secrets

| Secret | Where it lives | How to rotate |
|---|---|---|
| S3 access key / secret | chart Secret `<rel>-c11n-secrets` (from values) | change `backup.s3.accessKey/secretKey`, `helm upgrade --reuse-values --set …`; the hook re-applies settings on the next pod start (it is a one-shot per process) |
| PocketBase superuser password | the database | admin UI → superuser → change password, or `kubectl exec … -- /pb/pocketbase superuser update <email> <password> --dir=/pb/pb_data` |
| SMTP password | chart Secret (inert today) | change the value; nothing reads it yet |
| Session cookies | — | rotate `session.ttlDays` (shorter sessions) and restart; existing cookies keep their original expiry. There is no server-side session revocation: a stolen cookie is valid until it expires. Removing the user does invalidate it (the gate re-reads the user). |
| Invite links | database rows | they are single use and expire; delete unused rows to revoke them |

Rotating the chart's values is a `helm upgrade`, which (Recreate) restarts the
pod: a short outage.

## 7. Reaching the PocketBase admin UI

The admin UI is **not** on the review host: Caddy answers 404 for
`/__c11n/pb/_/*` on purpose. Use a port-forward:

```sh
kubectl port-forward deploy/<rel> -n <ns> 8090:8090
# http://127.0.0.1:8090/_/
```

`adminIngress.enabled=true` exists for operators who need it published, but it
puts the superuser login on a real hostname with no gate in front of it. If you
use it, put TLS, an IP allowlist or an auth proxy in front, and turn it off
when you are done.

Superuser accounts are separate from c11n users: the owner and reviewers do not
have admin UI accounts.

## 8. The owner lost their link / there is no owner

There is no email channel. An owner or team member can mint a fresh link from
the overlay (**Invite** → same email → copy the link).

If nobody can sign in (or the owner account is gone), mint one from the pod:

```sh
kubectl exec deploy/<rel> -n <ns> -c pocketbase -- \
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

Diagnose from inside the pod:

```sh
kubectl exec deploy/<rel> -c caddy -- wget -qO- --header 'Host: <host>' http://127.0.0.1:8080/__c11n/auth/
kubectl exec deploy/<rel> -c pocketbase -- wget -qO- http://127.0.0.1:8090/api/health
kubectl logs deploy/<rel> -c pocketbase | tail -50      # claim refusals are logged
```

### 502/503 from the ingress

The caddy container is up but PocketBase is not (Caddy gates through it), or the
upstream is unreachable. Check both containers' readiness, then:

```sh
kubectl logs deploy/<rel> --all-containers --prefix
kubectl exec deploy/<rel> -c caddy -- wget -qO- --spider <upstream.url>
```

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
schedules. If the pod is Pending too, `kubectl describe pod` says which
constraint failed (cpu/memory, nodeSelector, volume zone). Never use NFS for this
volume: SQLite on a network filesystem corrupts.

## 10. Uninstall

```sh
helm uninstall <rel> -n <ns>
```

What happens to the data: the PVC is annotated
`helm.sh/resource-policy: keep`, so **`helm uninstall` leaves both the claim and
its volume behind**. A reinstall re-adopts the claim and the site comes back
exactly as it was.

To delete everything, including the reviewed site's data:

```sh
helm uninstall <rel> -n <ns>
kubectl delete pvc <rel>-c11n-pb-data -n <ns>
# the StorageClass's reclaim policy then decides the volume's fate (Delete on
# most dynamic provisioners; `kubectl get pv` to confirm nothing is orphaned)
```

The chart's Secret (`<rel>-c11n-secrets`) goes with the release, as does the
Service and the Ingress. Take a backup first if the data matters — this is the
step with no undo.
