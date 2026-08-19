/// <reference path="../pb_data/types.d.ts" />

// v1 runs a single project per deployment; the overlay looks up slug "default".
migrate((app) => {
  const projects = app.findCollectionByNameOrId("projects");
  const record = new Record(projects);
  record.set("name", "Default");
  record.set("slug", "default");
  app.save(record);
}, (app) => {
  // findFirstRecordByData throws (rather than returning null) when no row
  // matches, so guard the down-path against an already-deleted seed row.
  try {
    const record = app.findFirstRecordByData("projects", "slug", "default");
    app.delete(record);
  } catch {
    // seed row already gone — nothing to do
  }
});
