// pb_hooks/comments.pb.js
// Runs on PocketBase JS VM to atomically assign monotonic `seq` per project on comment creation.

onRecordCreate((e) => {
  const project = e.record.get("project");
  if (!project) {
    e.next();
    return;
  }

  // Atomic max seq query + increment within transaction
  e.app.runInTransaction((txApp) => {
    const row = new DynamicModel({
      maxSeq: 0,
    });

    txApp.db()
      .newQuery("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM comments WHERE project = {:project}")
      .bind({ project })
      .one(row);

    const nextSeq = (row.maxSeq || 0) + 1;
    e.record.set("seq", nextSeq);
    e.next();
  });
}, "comments");
