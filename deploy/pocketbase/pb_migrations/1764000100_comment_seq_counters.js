/// <reference path="../pb_data/types.d.ts" />

// Per-project comment sequence counters (B2b).
//
// The comments hook used to do SELECT MAX(seq) + 1 inside the create
// transaction. That read does not take SQLite's write lock, so two creates in
// flight at the same time read the same max and one lost to
// idx_comments_project_seq (400 validation_not_unique).
//
// The counter row is now updated first, which takes the write lock before the
// value is read; `next` is the last seq handed out for the project.
//
// The down migration (dropping comment_counters) must be reverted together
// with the hook (pb_hooks/comments.pb.js), or every comment create fails.
//
// No autodate fields on purpose: the hook increments the counter with raw SQL,
// and the created/updated columns would then have to be filled by hand.
// All API rules stay null: only superusers and server-side hooks touch this.
migrate((app) => {
  const projects = app.findCollectionByNameOrId("projects");

  const counters = new Collection({
    type: "base",
    name: "comment_counters",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      {
        type: "relation",
        name: "project",
        required: true,
        collectionId: projects.id,
        maxSelect: 1,
        // Derived state: it must not outlive its project. With this off,
        // PocketBase refuses to delete any project the counter points at
        // ("part of a required relation reference"), i.e. every project that
        // ever had a comment became undeletable.
        cascadeDelete: true,
      },
      // Not `required`: PocketBase treats the zero value as blank, and 0 is a
      // legitimate starting counter for a project with no comments yet.
      { type: "number", name: "next" },
    ],
    // One counter per project. A relation field has no `unique` flag (the
    // schema normalizer drops it), so the upsert's ON CONFLICT target has to
    // come from an explicit unique index.
    indexes: ["CREATE UNIQUE INDEX idx_comment_counters_project ON comment_counters (project)"],
  });
  app.save(counters);

  // Backfill: each project starts at its current MAX(seq), so the next create
  // continues the sequence instead of colliding with existing rows.
  for (const project of app.findAllRecords("projects")) {
    const row = new DynamicModel({ maxSeq: 0 });
    app
      .db()
      .newQuery("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM comments WHERE project = {:project}")
      .bind({ project: project.id })
      .one(row);
    app.save(
      new Record(counters, {
        project: project.id,
        next: row.maxSeq,
      })
    );
  }
}, (app) => {
  app.delete(app.findCollectionByNameOrId("comment_counters"));
});
