/// <reference path="../pb_data/types.d.ts" />

// v1 runs a single project per deployment; the overlay looks up slug "default".
migrate((app) => {
  const projects = app.findCollectionByNameOrId("projects");
  const record = new Record(projects);
  record.set("name", "Default");
  record.set("slug", "default");
  app.save(record);
}, (app) => {
  const record = app.findFirstRecordByData("projects", "slug", "default");
  if (record) {
    app.delete(record);
  }
});
