# ADR 0008: Roles and permissions

**Status:** **Proposed** 2026-11-25

## Context

The users are our team and the client's team, and maybe an agent
(ADR 0001). Today the rules are "any authenticated user can do anything
except edit or delete other people's comments", and they have holes
(assessment S2: non-authors can rewrite `seq`; authors can reassign
`author`).

## Decision (proposed)

There is one `role` field on `users`, with these values:

| Capability | owner | team | client | agent* |
|---|---|---|---|---|
| View the site and comments | ✓ | ✓ | ✓ | ✓ |
| Comment and reply | ✓ | ✓ | ✓ | ✓ |
| Edit or delete **own** comment or reply | ✓ | ✓ | ✓ | ✓ |
| Resolve or reopen a thread | ✓ | ✓ | ✓ (own threads only) | ✓? |
| Delete any comment | ✓ | – | – | – |
| Invite `client` users | ✓ | ✓ | – | – |
| Invite `team` / `owner` users | ✓ | – | – | – |

\* Agent capabilities are open. See the plan's open questions.

- The rules are written in PocketBase API-rule syntax using `@request.auth.role`.
- `author`, `project` and `seq` are immutable after create. They are
  enforced in an `onRecordUpdateRequest` hook, not by blocklisting fields in
  rule strings.
- Replies inherit visibility from their comment. Realtime subscriptions are
  scoped by project.

## Consequences

- The overlay shows or hides actions by role. The backend still enforces
  everything.
- Every cell of this table gets an e2e permission test, so the matrix is
  executable.
