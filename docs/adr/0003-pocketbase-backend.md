# ADR 0003: PocketBase is the v1 backend

**Status:** Accepted 2026-08-19 (Tom). Unchanged 2026-11-25.

## Decision

PocketBase provides users, storage (SQLite), realtime (SSE), an admin UI,
JS hooks and migrations. The overlay talks to it **only** through
`C11nBackend` (`packages/overlay/src/lib/api.ts`), so it can be swapped for
a custom Go service later without touching the UI.

Server-side behaviour (seq numbering, magic links, the session gate) is
implemented as PocketBase JS hooks (`deploy/pocketbase/pb_hooks/`), not as
a separate service.

## Consequences

- **Single writer.** SQLite means one PocketBase replica per site. That fits
  ADR 0005.
- **The default `users` collection allows public signup** (`createRule: ""`,
  verified on 0.39.11). Our migrations must close it explicitly (plan
  Phase 2).
- Hooks must not nest transactions on a different app handle. The shipped
  `seq` hook did, and it deadlocked (assessment B2). The rule: use
  `onRecordCreateExecute` and `e.app`. That pattern was verified on 0.39.11
  with 13 creates, 10 of them concurrent: seqs 1..13, all unique.
- The PocketBase server and JS SDK versions are pinned together on
  purpose. Both are bumped in the same PR.
- Backups use PocketBase's built-in backup API, sent to S3-compatible
  storage (plan Phase 5).
