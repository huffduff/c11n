# End-to-end suite

The specs drive the real stack: PocketBase, Caddy and the demo vite dev server,
started from `scripts/stack.sh` (native binaries, no Docker). `global-setup.ts`
wipes `.stack/pb_data`, brings the stack up and reads `.stack/creds.json`;
`global-teardown.ts` runs `scripts/stack.sh down`.

## Run it

```bash
# 1. once per checkout: pinned tools (PocketBase download + Caddy build)
scripts/fetch-tools.sh

# 2. the suite (builds the overlay, then runs Playwright)
npm run e2e
```

`fetch-tools.sh` builds Caddy with xcaddy (needs `go`, pinned in
`.tool-versions`; `asdf install` if the shim says no version is set) and the
Caddy/PocketBase/xcaddy versions are pinned in `scripts/tools.env`. To skip the
build, point `CADDY_BIN` / `POCKETBASE_BIN` at prebuilt binaries —
`scripts/tools-lib.sh` resolves them the same way for every script. Re-running
`fetch-tools.sh` is idempotent: an existing `.tools/caddy` of the pinned version
is left alone.

`stack.sh up` refuses to start when 18090/15173/18080 are already listening
(it will not adopt a foreign process) and stops whatever it did start if any
step fails.

## This box: Playwright browsers

`PLAYWRIGHT_BROWSERS_PATH=/opt/hermes/tools` is exported here and points at an
older Chromium than `@playwright/test` expects. Run the suite with it unset:

```bash
env -u PLAYWRIGHT_BROWSERS_PATH npm run e2e
```

Do not bake this into `package.json` or the config: CI uses the normal browser
resolution and would break.

## Reading the results

`--reporter=list` prints one line per spec. Three markers besides a plain pass:

| marker | meaning |
| --- | --- |
| `✓` | passes |
| `✘` | failed (expected for `test.fail()`) |
| `-` | skipped (`test.fixme()`) |

Current known-bug markers (each becomes a passing spec when its fix lands):

- **B3 — `test.fixme`**: "a seeded comment renders its pin without scroll or
  resize". Pins stay `display:none` until a scroll/resize; the failure races
  the tracker's first rAF, so it reproduces about 5/10 under
  `--repeat-each=10`. `test.fail()` would itself flake, hence `fixme`.
- **B4 — `test.fail`**: "saving a comment renders exactly one pin". The
  realtime create echoes back and the comment renders two pins, 10/10. This is
  the only spec that is *expected to fail*; a green run shows it as `✘`.
- **reply echo — `test.fixme`**: "a UI reply is rendered once". One stored reply
  renders twice (1 row in the DB, 2 `.c11n-popover-reply-body` in the DOM),
  10/10 in isolation but it depends on whether the realtime echo beats the HTTP
  response, so `fixme` rather than `fail`.

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
