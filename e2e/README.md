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
```

## Two fixtures, one suite

The dogfood app is served by Vite in dev and by a Go backend in production
(ADR 0001), so the same suite runs against both topologies, each with its own
fresh stack:

| `C11N_FIXTURE` | upstream | port |
| --- | --- | --- |
| `vite` (default) | `examples/demo-vue` via the vite dev server (HMR) | 15173 |
| `go` | the built `examples/demo-vue/dist` via `examples/demo-go-server` | 15174 |

`stack.sh` builds the SPA and the Go binary into `.stack/` for the `go`
fixture. Upstreams are otherwise interchangeable: Caddy's config is identical,
and `specs/topology.spec.ts` holds the specs that only make sense for one side
(each skips on the other). CI runs the matrix over both fixtures.

`fetch-tools.sh` builds Caddy with xcaddy (needs `go`, pinned in
`.tool-versions`; `asdf install` if the shim says no version is set) and the
Caddy/PocketBase/xcaddy versions are pinned in `scripts/tools.env`. To skip the
build, point `CADDY_BIN` / `POCKETBASE_BIN` at prebuilt binaries —
`scripts/tools-lib.sh` resolves them the same way for every script. Re-running
`fetch-tools.sh` is idempotent: an existing `.tools/caddy` of the pinned version
(and `.tools/pocketbase` reporting the pinned version) is left alone.

`stack.sh up` refuses to start when 18090, 15173, 15174 or 18080 is already
listening — both fixture ports, so a stack left behind by the other fixture is
caught too — on 127.0.0.1 or ::1, and it will not adopt a foreign process. It
stops whatever it did start if any step fails, and the `go` fixture is built
before anything starts, so a build error leaves nothing running.

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
bootstrap owner (3.2), `POST /api/c11n/invite` (3.3), the magic-link callback
(3.4) and `session`/`me`/`logout` (3.6). It is API-level on purpose — the Caddy
gate and the sign-in page land in a later batch, so the specs call the hook
routes through the existing `/__c11n/pb` proxy and swap the
`/__c11n/auth/magic` prefix on the returned links.

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
| `C11N_COOKIE_SECURE` | true | true (the cookie is asserted as `Secure`) |

The `request` fixture shares one cookie jar across a spec file: use
`isolatedRequest()` from `fixtures.ts` for the "anonymous gets 401" assertions,
or they pass for the wrong reason after an earlier sign-in.

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
