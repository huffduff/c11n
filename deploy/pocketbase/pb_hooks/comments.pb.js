// pb_hooks/comments.pb.js
// Assign a monotonic per-project `seq` to every comment on creation.
//
// This runs in `onRecordCreateExecute`, which fires INSIDE the request's
// create transaction, and it queries through `e.app` — the transaction-bound
// app. That is what makes the read-then-write atomic without opening a
// transaction of our own: SQLite has a single writer, and the previous
// implementation called `e.next()` (whose save goes through the OUTER app)
// from inside `e.app.runInTransaction(...)`, which deadlocked the first
// create and wedged every later write until the process restarted (B2).
//
// NEVER nest `runInTransaction` in this hook: same deadlock.
// idx_comments_project_seq (migration 1755600002) is the backstop that
// surfaces a duplicate immediately.
onRecordCreateExecute((e) => {
  const row = new DynamicModel({ maxSeq: 0 })
  e.app.db()
    .newQuery("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM comments WHERE project = {:project}")
    .bind({ project: e.record.get("project") })
    .one(row)
  e.record.set("seq", row.maxSeq + 1)
  e.next()
}, "comments")
