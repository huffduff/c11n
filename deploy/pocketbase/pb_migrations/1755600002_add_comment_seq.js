/// <reference path="../pb_data/types.d.ts" />

migrate((app) => {
  const comments = app.findCollectionByNameOrId("comments");

  // Add seq field (number) to comments collection
  comments.fields.add(
    new Field({
      type: "number",
      name: "seq",
      min: 1,
    })
  );

  // Add project + seq unique index
  comments.indexes.push("CREATE UNIQUE INDEX idx_comments_project_seq ON comments (project, seq)");

  app.save(comments);
}, (app) => {
  const comments = app.findCollectionByNameOrId("comments");
  comments.fields.removeByName("seq");
  comments.indexes = comments.indexes.filter(
    (idx) => !idx.includes("idx_comments_project_seq")
  );
  app.save(comments);
});
