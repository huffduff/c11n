/// <reference path="../pb_data/types.d.ts" />

// Schema-as-code for c11n v1 (see docs/architecture.md):
//   projects  — one row per reviewed site (superuser-managed)
//   comments  — thread roots anchored to a CSS selector on a page path
//   replies   — flat replies under a comment
migrate((app) => {
  const usersId = app.findCollectionByNameOrId("users").id;

  // ---- projects -----------------------------------------------------------
  const projects = new Collection({
    type: "base",
    name: "projects",
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule: null, // superuser only
    updateRule: null,
    deleteRule: null,
    fields: [
      { type: "text", name: "name", required: true },
      { type: "text", name: "slug", required: true },
      { type: "url", name: "upstream" },
      { type: "autodate", name: "created", onCreate: true },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_projects_slug ON projects (slug)"],
  });
  app.save(projects);

  // ---- comments -----------------------------------------------------------
  const comments = new Collection({
    type: "base",
    name: "comments",
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule: '@request.auth.id != "" && author = @request.auth.id',
    // Author may edit anything; any other authenticated user may ONLY toggle `resolved`.
    updateRule:
      '@request.auth.id != "" && (author = @request.auth.id || (@request.body.body:isset = false && @request.body.selector:isset = false && @request.body.anchorMeta:isset = false && @request.body.path:isset = false && @request.body.project:isset = false && @request.body.author:isset = false))',
    deleteRule: 'author = @request.auth.id',
    fields: [
      {
        type: "relation",
        name: "project",
        required: true,
        collectionId: app.findCollectionByNameOrId("projects").id,
        maxSelect: 1,
        cascadeDelete: false,
      },
      { type: "text", name: "path", required: true },
      { type: "text", name: "selector", required: true },
      { type: "json", name: "anchorMeta", maxSize: 50000 },
      { type: "text", name: "body", required: true },
      {
        type: "relation",
        name: "author",
        required: true,
        collectionId: usersId,
        maxSelect: 1,
        cascadeDelete: false,
      },
      { type: "bool", name: "resolved" },
      { type: "autodate", name: "created", onCreate: true },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
    ],
    indexes: [
      // Hot query: the overlay lists comments per project+page on every load/navigation.
      "CREATE INDEX idx_comments_project_path ON comments (project, path)",
    ],
  });
  app.save(comments);

  // ---- replies ------------------------------------------------------------
  const replies = new Collection({
    type: "base",
    name: "replies",
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule: '@request.auth.id != "" && author = @request.auth.id',
    updateRule: 'author = @request.auth.id',
    deleteRule: 'author = @request.auth.id',
    fields: [
      {
        type: "relation",
        name: "comment",
        required: true,
        collectionId: app.findCollectionByNameOrId("comments").id,
        maxSelect: 1,
        cascadeDelete: true,
      },
      { type: "text", name: "body", required: true },
      {
        type: "relation",
        name: "author",
        required: true,
        collectionId: usersId,
        maxSelect: 1,
        cascadeDelete: false,
      },
      { type: "autodate", name: "created", onCreate: true },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
    ],
  });
  app.save(replies);
}, (app) => {
  // Reverse order: children before parents.
  app.delete(app.findCollectionByNameOrId("replies"));
  app.delete(app.findCollectionByNameOrId("comments"));
  app.delete(app.findCollectionByNameOrId("projects"));
});
