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
- **API only:** the agent cannot browse the site. The session route (the
  `forward_auth` target) answers 403 to an HTML document request when
  `role = "agent"`, so the reviewed site's pages never load for it, while
  every API call still passes. Its `resolved` field is unwritable by rule, even
  on a comment a superuser seeded with the agent as author.
- **Credential:** a token minted by an owner through PocketBase impersonate,
  sent as a bearer token on a non-cookie path (ADR 0006). Everything the
  agent does is attributed to the agent user.

- The rules are written in PocketBase API-rule syntax using `@request.auth.role`.
- `author`, `project` and `seq` are immutable after create. They are
  enforced in an `onRecordUpdateRequest` hook, not by blocklisting fields in
  rule strings.
- There is **no per-project read scoping**, deliberately. `comments.listRule`
  and `viewRule` (and `replies'`) require
  `@request.auth.id != "" && @request.auth.role != ""`: any authenticated user
  carrying a role reads every comment and reply in the deployment. That is the
  boundary ADR 0005 draws — one reviewed site per deployment, so the only
  accounts that exist are that project's stakeholders — and the role clause is
  what closes S3: an unauthenticated or role-less token reads nothing. (Before
  Phase 3 task 3.10, any authenticated token read everything, which is the hole
  S3 named.) The overlay's realtime subscription sends a project filter that
  the server applies, but the filter is *chosen by the client*, so it stays a
  UI convenience, not an access control. Building project membership on top of
  one-project-per-deployment would add a concept with nothing to enforce; if a
  deployment ever hosts more than one project, that is when the rules become
  project-scoped.

## Consequences

- The overlay shows or hides actions by role: no comment mode for the agent,
  Resolve/Reopen only where the matrix allows, Delete on others' comments for
  the owner. The backend still enforces everything; a hidden button is a
  courtesy, never the control.
- Every cell of this table gets an e2e permission test
  (`e2e/specs/permissions-matrix.spec.ts`), so the matrix is executable.
  `scripts/check-rule-floor.mjs` additionally proves the tightened cells from
  the rule strings alone, with an empty `pb_hooks` dir.
- Enforced with their fields in Phase 7.1: the triage (`category`, `priority`,
  `triage`) and ticket (`ticketUrl`, `ticketKey`) rows. The agent credential
  path is Phase 7 too; the role's behaviour on the existing actions is enforced
  already.
- The invite rows stay in `pb_hooks/identity.pb.js` (team → client, owner →
  any); the matrix spec covers them alongside the rule-level cells.
