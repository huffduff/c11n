# Running the Playwright suite against a real deployment

Phase 5 task 5.5. The suite normally starts its own native stack
(`scripts/stack.sh`) and talks to `127.0.0.1:18080`. **External mode** points it
at an existing deployment instead — in practice the closedcloud test cluster
after `scripts/cluster/install-closedcloud.sh` — with no stack started, torn
down or wiped.

```
C11N_E2E_EXTERNAL=1 \
C11N_E2E_ALLOW_DESTRUCTIVE=1 \
C11N_E2E_BASE_URL=http://127.0.0.1:18080 \
C11N_E2E_PB_URL=http://127.0.0.1:18090 \
C11N_E2E_SU_EMAIL=e2e-su@c11n.test \
C11N_E2E_SU_PASSWORD=<a-long-e2e-password> \
C11N_FIXTURE=go \
npx -w e2e playwright test
```

`C11N_E2E_ALLOW_DESTRUCTIVE=1` is required: the suite deletes every comment and
reply (`resetData`) and creates users in whatever it points at, so external mode
will not start without it. In addition it refuses to start unless **both**
`C11N_E2E_BASE_URL` and `C11N_E2E_PB_URL` are loopback (`127.0.0.1`,
`localhost`, `::1` — the port-forward above) or end in `.closedcloud.test`. For
a test cluster behind any other name, add
`C11N_E2E_I_KNOW_THIS_IS_NOT_PRODUCTION=1`; a real client's review site is never
a target.

`C11N_FIXTURE=go` is not strictly required (external mode defaults to `go`), but
saying it out loud documents the assumption: the install deploys the Go demo
server, so the `go` topology specs apply.

## 1. Prerequisites

- The release is installed: `scripts/cluster/install-closedcloud.sh`.
- `kubectl` reaches the cluster (`KUBECONFIG` set) and the release is `c11n` in
  namespace `default` (override below if not).

## 2. A superuser for the fixtures

The specs create users and read invite rows as a superuser: public signup is
closed and password auth is off for `users`, so the fixtures need the one
account that can do both. It has nothing to do with the owner's account.

```
kubectl exec deploy/c11n -c pocketbase -- \
  /pb/pocketbase superuser upsert e2e-su@c11n.test 'a-long-e2e-password' --dir=/pb/pb_data
```

`--dir` is required because the container's default data dir is set by the CMD's
flag, not by the executable. Re-run the command to rotate the password; it
upserts.

## 3. Reach the two origins

Two different origins are needed, because the fixtures talk to PocketBase
**directly** for seeding: the superuser API must not go through the proxy under
test (the proxy overwrites Authorization with the session cookie, by design).

```
kubectl port-forward deploy/c11n 18080:8080 18090:8090
```

- `18080` → Caddy in the pod: the review origin, the same port the local stack
  uses, so `C11N_E2E_BASE_URL=http://127.0.0.1:18080` and any invite link the
  install prints work unchanged.
- `18090` → PocketBase in the same pod: `C11N_E2E_PB_URL=http://127.0.0.1:18090`.

Keep that command running in its own shell; the suite does not manage it.

### Why a port-forward and not the Traefik hostname

Traefik routes by the `Host` header, and a browser navigation always sends the
host from the URL — `extraHTTPHeaders` cannot change it. Two workable routes:

1. **Port-forward (recommended).** No DNS, no host mapping, and
   `127.0.0.1` is a secure context, so cookie behaviour matches the local stack.
2. **Host mapping.** Add `--host-resolver-rules="MAP c11n.closedcloud.test
   <cluster address>"` to Chromium's launch args (a `launchOptions.args` entry
   in `e2e/playwright.config.ts`) and use `C11N_E2E_BASE_URL=http://c11n.closedcloud.test:80`.
   This needs `cookie.secure=false` on the release (the install script sets it)
   and a resolver rule per host, including the admin host if you use it.
   Nothing in this repo implements that today: it is the documented alternative,
   not the supported path.

## 4. What skips in external mode, and why

Nothing in the suite is silently weakened: every exclusion is a `test.skip`
with a reason, and the rest of the file still runs.

| Spec | Skips | Because |
|---|---|---|
| `identity.spec` "3.2 bootstrap owner" | whole describe | the one-time link is on the pod's stdout; read it with `kubectl logs deploy/c11n -c pocketbase \| grep 'c11n bootstrap'` |
| `token-logs.spec` | whole file | reads the local stack log for the bootstrap token |
| `smoke.spec` "Caddyfile env matrix" | whole describe | needs `CADDY_BIN` (native `caddy validate`); the cluster runs the same file baked into the image |
| `topology.spec` "gzip-accepting HTML request" | the direct-upstream half | talks to `127.0.0.1:15174`, the local fixture port; the in-cluster upstream has no published port |
| `phase3-exit.spec` | nothing | it mints a fresh owner link instead of reading the bootstrap log |

`globalSetup` in external mode only validates the environment and probes both
URLs (the sign-in page on the proxy, `/api/health` on PocketBase) — a typo'd
URL fails in one second with one message instead of forty spec failures.
`globalTeardown` does nothing.

## 5. Caveats

- **The suite writes to the deployment.** It creates users (`e2e-*@c11n.test`,
  `client-*@example.test`), comments and replies, and `resetData()` deletes
  every comment/reply before several specs. That is fine on a disposable test
  cluster; never point external mode at a real client's review site. Three keys
  enforce that: `C11N_E2E_ALLOW_DESTRUCTIVE=1` is mandatory, both origins must
  be loopback or `*.closedcloud.test`, and any other hostname additionally needs
  `C11N_E2E_I_KNOW_THIS_IS_NOT_PRODUCTION=1`. `globalSetup` and `resetData()`
  both refuse, with the reason in the message (`e2e/external-guard.ts`).
- The overlay is the one baked into the Caddy image. If you changed the overlay
  locally, rebuild and reinstall — building `packages/overlay/dist` here proves
  nothing about the running pod.
- One worker, one deployment: the specs assert on global row sets
  (`fullyParallel: false`, `workers: 1`).
