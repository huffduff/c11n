# Architecture Decision Records

Each ADR records one decision: its context, the choice, and its consequences.

**Statuses:**

- **Accepted**: confirmed by Tom (date given).
- **Proposed**: recommended, waiting on Tom's confirmation. Don't build on it until it's accepted.
- **Superseded**: replaced by a later ADR.

| # | Decision | Status |
|---|---|---|
| [0001](0001-audience-and-success.md) | Audience is our team plus client team members (maybe an agent). Success means dogfooding on one client project | Accepted 2026-11-25 |
| [0002](0002-proxy-injection-delivery.md) | Deliver the overlay by reverse-proxy injection. The proxy is also the security boundary | Accepted 2026-08-19, re-affirmed 2026-11-25 |
| [0003](0003-pocketbase-backend.md) | PocketBase is the v1 backend, behind the `C11nBackend` interface | Accepted 2026-08-19 |
| [0004](0004-shadow-dom-vue-overlay.md) | Vue 3 overlay, single IIFE bundle, mounted in a shadow DOM | Accepted 2026-08-19 |
| [0005](0005-one-deployment-per-site.md) | One k8s deployment per reviewed site, one container per service, everything configurable. Compose is for dev only | Accepted 2026-11-25 |
| [0006](0006-passwordless-identity-at-the-proxy.md) | Passwordless invite / magic-link identity, httpOnly session cookie, proxy-enforced gate. MVP invites are copy-the-link | Accepted 2026-11-25 |
| [0007](0007-stack-e2e-is-definition-of-done.md) | A scripted full-stack e2e test is the definition of done | Accepted 2026-11-25 |
| [0008](0008-roles-and-permissions.md) | Roles: owner / team / client / agent. The agent triages and turns comments into tickets | Accepted 2026-11-25 |
| [0009](0009-dogfood-target-sasser-vite-dev.md) | Dogfood target is `huffduff/sasser-studios` `frontend/` in Vite dev mode (mock data), app login out of scope, its deep-link 404 is its bug | Accepted 2026-11-27 |

## Housekeeping decisions (2026-11-25, Tom: "be aggressive with cleanup")

- Deleted the 6 merged remote branches. Their tips are recorded here so
  they can be restored:
  - `chore/reboot-workspace` @ `53bd0a9`
  - `feature/deploy-skeleton` @ `51ca157`
  - `feature/overlay-mvp` @ `65aa35c`
  - `feature/demo-ci-docs` @ `2fe5d06`
  - `feature/persistent-seq-numbers` @ `6d54818`
  - `blacksmith-migration-e7d5695` @ `74cd731`

  All are reachable from `main`.
- Turned on the GitHub setting "Automatically delete head branches" on
  merge, so merged branches no longer pile up.
- Archived the 2026-08-19 reboot plan to `.kilo/plans/archive/`. Kept, not
  deleted, because it records the original reasoning.
- New working plan: `.kilo/plans/2026-11-25-c11n-dogfood.md`.
