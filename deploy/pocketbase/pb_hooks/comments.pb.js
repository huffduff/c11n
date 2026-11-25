// pb_hooks/comments.pb.js
// Assign a monotonic per-project `seq` to every comment on creation.
//
// This runs in `onRecordCreateExecute`, which fires INSIDE the request's
// create transaction, and it queries through `e.app` — the transaction-bound
// app. That is what makes the counter update atomic without opening a
// transaction of our own: SQLite has a single writer, and the previous
// implementation called `e.next()` (whose save goes through the OUTER app)
// from inside `e.app.runInTransaction(...)`, which deadlocked the first
// create and wedged every later write until the process restarted (B2).
//
// The counter is incremented FIRST, in a single statement: the upsert takes
// SQLite's write lock before the value is read. The earlier
// `SELECT MAX(seq) + 1` read took no lock, so simultaneous creates read the
// same max and one lost to idx_comments_project_seq (B2b, 400
// validation_not_unique).
//
// NEVER nest `runInTransaction` in this hook: same deadlock.
// idx_comments_project_seq (migration 1755600002) is the backstop that
// surfaces a duplicate immediately.
onRecordCreateExecute((e) => {
  // comment_counters.next is the last seq handed out for the project, so the
  // upsert's inserted value (1) and its increment both yield the seq to use.
  const counter = new DynamicModel({ next: 0 })
  e.app.db()
    .newQuery(
      "INSERT INTO comment_counters (id, project, next) VALUES ({:id}, {:project}, 1) " +
        "ON CONFLICT(project) DO UPDATE SET next = next + 1 RETURNING next"
    )
    .bind({
      id: $security.randomStringWithAlphabet(15, "abcdefghijklmnopqrstuvwxyz0123456789"),
      project: e.record.get("project"),
    })
    .one(counter)
  e.record.set("seq", counter.next)
  e.next()
}, "comments")
