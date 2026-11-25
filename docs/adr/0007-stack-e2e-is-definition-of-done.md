# ADR 0007: A scripted full-stack e2e test is the definition of done

**Status:** Accepted 2026-11-25 (Tom)

## Context

On 2026-08-22, `main` had 175 passing unit tests and green CI. Yet the
default stack couldn't start (B1), comment creation deadlocked (B2), pins
were invisible on load (B3), and saving rendered a duplicate pin (B4). Every
test stops at a mocked `C11nBackend` or at jsdom.

All four bugs were found in under an hour by running the real binaries:

- Caddy with `replace-response`
- PocketBase
- the demo Vite app
- headless Chromium

## Decision

- An `e2e/` workspace (Playwright) runs against the real stack.
  `scripts/stack.sh` starts it from native binaries, so neither CI nor dev
  machines need Docker.
- A task that touches user-visible behaviour, `deploy/`, hooks or
  migrations is **not done** until an e2e spec covers it and passes, both
  locally and in CI.
- CI gets a required `e2e` job. The existing `overlay` job stays: unit tests
  are still the fast feedback loop.
- Bug fixes start with a failing e2e (or unit) test that reproduces the bug.
- The k8s path is verified separately: Helm install on an ephemeral k3s
  cluster, then a smoke run of the same e2e suite against its ingress (plan
  Phase 5).

## Consequences

- Each PR's CI takes a few minutes longer.
- Caddy and PocketBase binaries are pinned and cached in CI. The Caddy build
  with `replace-response` comes from the official Caddy download API.
