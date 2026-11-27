# ADR 0008: Roles and permissions

**Status:** Accepted 2026-11-25 (Tom). The agent's role was defined by Tom
the same day: **triage, and turn comments into tickets.**

## Context

The users are our team and the client's team, and maybe an agent
(ADR 0001). Today the rules are "any authenticated user can do anything
except edit or delete other people's comments", and they have holes
(assessment S2: non-authors can rewrite `seq`; authors can reassign
`author`).

## Decision

There is one `role` field on `users`, with these values:

| Capability | owner | team | client | agent |
|---|---|---|---|---|
| View the site and comments | ✓ | ✓ | ✓ | ✓ (API only, no site browsing) |
| Comment and reply | ✓ | ✓ | ✓ | reply only |
| Edit or delete **own** comment or reply | ✓ | ✓ | ✓ | ✓ |
| Resolve or reopen a thread | ✓ | ✓ | ✓ (own threads only) | – |
| Set triage fields (`category`, `priority`, `triage`) | ✓ | ✓ | – | ✓ |
| Link a ticket (`ticketUrl`, `ticketKey`) | ✓ | ✓ | – | ✓ |
| Delete any comment | ✓ | – | – | – |
| Invite `client` users | ✓ | ✓ | – | – |
| Invite `team` / `owner` users | ✓ | – | – | – |

### Agent role

- **Triage:** the agent classifies each new comment, setting `category`
  (bug / design / content / question), `priority` and
  `triage = new → triaged → ticketed`. It can reply on the thread to ask
  the reviewer for more detail.
- **Tickets:** the agent creates an issue in the configured tracker and
  writes `ticketUrl` and `ticketKey` back onto the comment. The UI shows the
  ticket link on the pin and in the sidebar.
- The agent **never resolves** threads. A human closes the loop.
- **Credential:** a token minted by an owner through PocketBase impersonate,
  sent as a bearer token on a non-cookie path (ADR 0006). Everything the
  agent does is attributed to the agent user.

- The rules are written in PocketBase API-rule syntax using `@request.auth.role`.
- `author`, `project` and `seq` are immutable after create. They are
  enforced in an `onRecordUpdateRequest` hook, not by blocklisting fields in
  rule strings.
- There is **no per-project read scoping yet.** `comments.listRule` and
  `viewRule` (and `replies`') only require `@request.auth.id != ""`, so any
  authenticated user can read every comment and reply in the deployment, not
  just the ones on a page or project they were given. The overlay's realtime
  subscription sends a project filter that the server applies, but the filter
  is *chosen by the client*, so it is a UI convenience, not an access control.
  This is acceptable for now because ADR 0005 gives each reviewed site its own
  deployment: the only accounts that exist are that project's stakeholders.
  Phase 2 closes the write side (S2); the read side stays open until Phase 3
  task 3.10 makes the list/view rules role- and project-aware, which closes S3
  fully.

## Consequences

- The overlay shows or hides actions by role. The backend still enforces
  everything.
- Every cell of this table gets an e2e permission test, so the matrix is
  executable.
