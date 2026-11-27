# End-to-end suite

The specs drive the real stack: PocketBase, Caddy and a demo upstream, started
from `scripts/stack.sh` (native binaries, no Docker). `global-setup.ts` wipes
`.stack/pb_data`, brings the stack up and reads `.stack/creds.json`;
`global-teardown.ts` runs `scripts/stack.sh down`.

## Run it

```bash
# 1. once per checkout: pinned tools (PocketBase download + Caddy build)
scripts/fetch-tools.sh

# 2. the suite against both fixtures (builds the overlay first)
npm run e2e

# or one fixture at a time
npm run e2e:vite
npm run e2e:go
npm run e2e:sasser   # the real dogfood app (ADR 0009)
```

## Fixtures

The dogfood app is served by Vite in dev and by a Go backend in production
(ADR 0001), so the same generic suite runs against both demo topologies, each
with its own fresh stack. A third fixture proxies the **real client app**, the
`sasser-studios` frontend, and runs the compatibility probe instead of the demo
specs:

| `C11N_FIXTURE` | upstream | port | specs |
| --- | --- | --- | --- |
| `vite` (default) | `examples/demo-vue` via the vite dev server (HMR) | 15173 | all |
| `go` | the built `examples/demo-vue/dist` via `examples/demo-go-server` | 15174 | all |
| `sasser` | `huffduff/sasser-studios` `frontend/` via its own vite dev server, HTTPS | 15175 | `specs/upstream-compat.spec.ts` |

`stack.sh` builds the SPA and the Go binary into `.stack/` for the `go`
fixture. Upstreams are otherwise interchangeable: Caddy's config is identical,
and `specs/topology.spec.ts` holds the specs that only make sense for one side
(each skips on the other). CI runs the matrix over both demo fixtures, plus a
separate `e2e (sasser)` job for this one.

Spec selection for `sasser` is `testMatch` in `playwright.config.ts`, not
per-spec skips: the demo specs drive demo-vue's own DOM (`#hero-title`,
`/pricing`, `api: go`) and would fail on any other app, so the cheapest honest
answer is not to select them. The reverse direction — `upstream-compat.spec.ts`
on the vite/go runs — is a describe-level `test.skip`, the same pattern
`topology.spec.ts` already uses.

## The sasser fixture (Phase 4, ADR 0009)

The target is a **private** repo, pinned by full sha in `scripts/tools.env`
(`SASSER_REPO`, `SASSER_REF`). Bump `SASSER_REF` deliberately: a new commit in
that repo must not turn CI red unannounced.

```bash
# a checkout you already have (CI does this, with a read-only deploy key)
C11N_SASSER_DIR=/path/to/sasser-studios npm run e2e:sasser

# or let the stack shallow-fetch the pinned sha into .stack/sasser-studios
# (authenticates with YOUR git setup for github.com: `gh auth setup-git`)
npm run e2e:sasser
```

- `C11N_SASSER_DIR` must be at `SASSER_REF` **with no changes to tracked
  files**, or `up` refuses (the probe has to mean *the pinned commit* passed);
  untracked files such as `node_modules` are fine. `C11N_SASSER_ALLOW_DIRTY=1`
  overrides both the HEAD check and the dirty check for a local experiment,
  with a loud warning that a pass is then not evidence about the pin.
- Without `C11N_SASSER_DIR` the clone is a plain `https` fetch: no token is
  handled, stored or logged by `stack.sh`, so the box's git credentials must
  already work for the private repo. On failure it says to set
  `C11N_SASSER_DIR` or configure git credentials. The same tracked-file rule
  applies to `.stack/sasser-studios` when a previous run's clone is reused:
  HEAD is verified first (and only then is the reuse logged), and a locally
  edited tracked file is refused unless `C11N_SASSER_ALLOW_DIRTY=1`.
- Dependencies are installed only when missing or when a manifest changed (the
  stamp, over `package.json`, `frontend/package.json` and `package-lock.json`,
  is in `.stack/`, never in the client checkout). `frontend/` is an npm
  workspace of that repo's root, so npm runs at the checkout root and hoists
  `node_modules/`. `SASSER_REF` **does** track `package-lock.json`, so the only
  recipe is `npm ci` (a lock-less install would re-resolve sasser's `vite:
  beta` / `vue: beta` dist-tags); a checkout without a lockfile is refused.
- The dev server runs on **`node` 24.19.0**, c11n's pin from `.tool-versions`,
  passed as `ASDF_NODEJS_VERSION` because sasser's own `.tool-versions` pins
  node 25, which is not installed anywhere here. That variable is only read by
  asdf's nodejs plugin: in CI, `setup-node` provides the same node from c11n's
  `.tool-versions` and the variable is inert. Their `.tool-versions` is not
  edited.
- Upstream TLS is `insecure` for this fixture only (self-signed vite cert).
  `stack.sh` refuses `C11N_UPSTREAM_TLS=insecure` for the demo fixtures and
  refuses anything else for `sasser`.
- `down` stops the vite process by pidfile, by process group; the marker check
  carries `--port 15175`, so no unrelated vite on the box can be adopted or
  killed.

### CI (`e2e (sasser)`)

`.github/workflows/ci.yml` runs this fixture as its own job, `e2e (sasser)` —
not a third value in the `e2e` matrix, so the deploy key never reaches the
`vite` and `go` runners. In order:

- a step reads `SASSER_REF` out of `scripts/tools.env` into a step output,
  after checking it is a full 40-char lowercase sha (it goes on a `git`
  command line): the sha is never duplicated in the workflow, so bumping the
  pin moves the checkout and the fixture's HEAD assertion together;
- a step exports `secrets.SASSER_DEPLOY_KEY` and publishes `has_key`, because a
  secret cannot be referenced from an `if:`. Every later step is gated on it;
- ONE `run:` step checks `huffduff/sasser-studios` out at that sha into
  `.stack-sasser/` (outside the npm workspace patterns, gitignored, and not
  globbed by any test or check), using the read-only deploy key
  "c11n CI (read-only)". The key is `env:`-scoped to that step only, written
  under `$RUNNER_TEMP` with `umask 077`, used for a single
  `git fetch <url> <sha>`, and removed by an `EXIT` trap — so it is gone before
  `npm ci`, the probe and every dependency's install script run, and it never
  reaches a `.git/config` (no remote is added; the fetch is by URL).
  Host-key checking is on against GitHub's published ed25519 key. This is
  deliberately not `actions/checkout` with `ssh-key:`, which leaves the key on
  disk until its post-job step;
- a step asserts that checkout's HEAD really is `SASSER_REF`, that
  `.git/config` carries no url/credential setting, and logs the commit subject,
  so the run's log is evidence about the pin;
- `C11N_SASSER_DIR` points at `.stack-sasser/`; `stack.sh` does the `npm ci`
  and the vite dev server as it does locally.

That job uploads **no Playwright artifact** — a trace, screenshot or video of
the private app's DOM is not something a public repo's actions may keep. The
config sets `trace: 'off'` for this fixture (screenshots/videos are off by
default), and the only failure artifact is `.stack/*.log`, the services' own
logs, retained for a week.

Without the secret (a `pull_request` from a fork) the job succeeds having done
nothing: a `::notice::` and a job-summary line say the probe did not run, and
the leg is not counted as evidence. Node is c11n's pin from `.tool-versions`;
sasser's own `.tool-versions` is not read.


`fetch-tools.sh` builds Caddy with xcaddy (needs `go`, pinned in
`.tool-versions`; `asdf install` if the shim says no version is set) and the
Caddy/PocketBase/xcaddy versions are pinned in `scripts/tools.env`. To skip the
build, point `CADDY_BIN` / `POCKETBASE_BIN` at prebuilt binaries —
`scripts/tools-lib.sh` resolves them the same way for every script. Re-running
`fetch-tools.sh` is idempotent: an existing `.tools/caddy` of the pinned version
(and `.tools/pocketbase` reporting the pinned version) is left alone.

`stack.sh up` refuses to start when 18090, 15173, 15174, 15175 or 18080 is
already listening — every fixture port, so a stack left behind by another
fixture is caught too — on 127.0.0.1 or ::1, and it will not adopt a foreign
process. It stops whatever it did start if any step fails, and the `go` and
`sasser` fixtures are prepared (build, checkout, install) before anything
starts, so a failure there leaves nothing running.

## This box: Playwright browsers

`PLAYWRIGHT_BROWSERS_PATH=/opt/hermes/tools` is exported here and points at an
older Chromium than `@playwright/test` expects. Run the suite with it unset:

```bash
env -u PLAYWRIGHT_BROWSERS_PATH npm run e2e
```

Do not bake this into `package.json` or the config: CI uses the normal browser
resolution and would break.

## Identity specs (Phase 3)

`specs/identity.spec.ts` covers the backend half of ADR 0006/0008: the
bootstrap owner (3.2), `POST /api/c11n/invite` (3.3), the magic-link claim
(3.4), `session`/`me`/`logout` (3.6) and password auth being off (3.9).
`specs/token-logs.spec.ts` proves no raw token reaches `_logs`,
`specs/claim-csrf.spec.ts` covers unfurlers and cross-origin claims, and
`specs/next-redirect.spec.ts` proves `next` cannot leave the origin.

Where those routes are reachable from has changed with the gate (3.8):

- `/__c11n/auth/` (the sign-in / "Continue" page) and `/__c11n/auth/claim` are
  **public**; the dogfood specs use the invite links as returned, through the
  proxy. `/__c11n/auth/magic` is the legacy GET path and is inert.
- `/api/c11n/session`, `/api/c11n/me`, `/api/c11n/invite` and the collections
  are **pod-internal** now. Fixtures and API-level specs call PocketBase on its
  own port (`pbUrl` in `.stack/creds.json`): a bearer sent through the proxy is
  overwritten by the session cookie, and with no cookie the gate answers 401.

`specs/identity-gate.spec.ts` is the gate and the overlay half: 302 vs 401, the
`next` parameter, the admin-UI 404, a forged bearer losing to the cookie, no
token in `localStorage`, logout, a session whose user was deleted, and the
invite UI into a fresh browser context. `specs/phase3-exit.spec.ts` is the whole
flow in one run (owner → team → client → comment → resolve).

Sign-in helpers, all in `fixtures.ts`:

- `signInAs(page, email?, role?)` — mints a magic link as superuser, opens it
  through the proxy, clicks "Continue to review", then waits for the authed
  toolbar.
- `openMagicLinkInPage(page, link, next?)` — the fragment-link browser flow,
  without minting.
- `claimInvite(request, link, opts?)` — the same POST the page makes, without a
  browser (`opts.origin` / `opts.contentType` for the CSRF specs).
- `sessionCookie(email, role?)` — the `c11n_session=…` header for API specs.
- `userToken(email)` — a bearer via the superuser impersonate endpoint.
- `bootstrapInviteLink()` — the owner's one-time link from the log.

The bootstrap link is read from `.stack/pocketbase.log` (it is the only copy of
the token; `pb_hooks/bootstrap.pb.js` logs it so an operator can find it with
`kubectl logs`). Env knobs the specs rely on, all with production defaults and
overridden by `scripts/stack.sh` for the local stack:

| var | default | local stack |
| --- | --- | --- |
| `C11N_OWNER_EMAIL` | unset (hint logged) | `owner@c11n.test` |
| `C11N_PUBLIC_URL` | request origin | `http://127.0.0.1:18080` |
| `C11N_LINK_TTL_HOURS` | 72 | 72 |
| `C11N_SESSION_TTL_DAYS` | 14 | 14 |
| `C11N_INVITE_RATE_PER_HOUR` | 30 | 30 |
| `C11N_COOKIE_SECURE` | true | true (the cookie is asserted as `Secure`) |

Both TTL knobs are validated once at load: a non-integer or out-of-range value
(`C11N_SESSION_TTL_DAYS` 1..30, `C11N_LINK_TTL_HOURS` 1..168) falls back to the
default and prints a warning on stdout. `node scripts/check-env-validation.mjs`
pins that behaviour.

The `request` fixture shares one cookie jar across a spec file: use
`isolatedRequest()` from `fixtures.ts` for the "anonymous gets 401" assertions,
or they pass for the wrong reason after an earlier sign-in.

## The compatibility probe (Phase 4)

`specs/upstream-compat.spec.ts` is the only spec the `sasser` fixture runs. Per
route (`/today`, `/schedule`, `/members`, `/members/<a mock user id>`,
`/packages`) it asserts that the overlay is injected, that the proxy introduces
no console error or `pageerror` the app does not already produce when the same
route is loaded directly on the upstream (a second context with
`ignoreHTTPSErrors`), that the URL stays on the review host after an in-app
sidebar navigation, that no same-origin request fails, and that nothing
navigates to Zitadel/`/login`/`/auth/callback` (app login is out of scope,
ADR 0009). Once per run it also checks the vite HMR websocket through the proxy,
a full comment round trip anchored to a member table row (pin, reload, storage),
and that the overlay's shadow-DOM styles do not leak into the app's computed
styles.

Both error sets are printed for every route so a failure is diagnosable without
a trace. The overlay's own realtime `EventSource` is aborted on every full page
load, which Chromium reports as a failed request; only that URL and only
`ERR_ABORTED` is excluded, and the number of established streams is printed
next to the aborts.

A real incompatibility found here is committed as `test.fail()` with the
symptom and evidence, not fixed in the probe (Task 4.3 fixes proxies) and not
weakened into a pass.

## Reading the results

`--reporter=list` prints one line per spec. Three markers besides a plain pass:

| marker | meaning |
| --- | --- |
| `✓` | passes |
| `✘` | failed (expected for `test.fail()`) |
| `-` | skipped (`test.fixme()`) |

Known-bug markers: none right now. The three Phase 2 overlay bugs are fixed and
their specs are plain specs, run every time:

| bug | spec | fix |
| --- | --- | --- |
| B3 | "a seeded comment renders its pin without scroll or resize" | `trackElements` returns `{ stop, refresh }`; `PinLayer` calls `refresh()` when it re-resolves with an existing tracker, so pins get their rects on load |
| B4 | "saving a comment renders exactly one pin" | `saveComment` upserts by id instead of pushing, so the realtime echo is an update, not a second record |
| B5 | "a UI reply is rendered once" | `addReply` and the realtime reply handlers share one upsert, so one stored reply renders one body |

B2 (the seq hook) is fixed and covered by normal specs, including
`10 parallel creates get unique seqs 1..10`; that one is the regression guard
for the race, so run it with `--repeat-each=10 -g "10 parallel"` if you change
`deploy/pocketbase/pb_hooks/comments.pb.js`.

## Run one spec

```bash
env -u PLAYWRIGHT_BROWSERS_PATH npm test -w e2e -- -g "10 parallel"
env -u PLAYWRIGHT_BROWSERS_PATH npm test -w e2e -- --repeat-each=10 -g "B4"
```

One worker, one shared stack on purpose: PocketBase has a single SQLite file and
the specs assert on global row sets, so parallel workers would race each other.
