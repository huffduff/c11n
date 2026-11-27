/// <reference path="../pb_data/types.d.ts" />

// S1 — close public signup on the users collection.
//
// PocketBase's built-in `users` collection ships with `createRule: ""`, and an
// empty rule means "anyone, no auth required" (verified on 0.39.11, and on
// this repo by the signup spec: an anonymous POST to
// /api/collections/users/records returned 200 before this migration).
//
// `null` means "superuser only", so user creation goes through the superuser
// token: the e2e fixtures, and in production the admin UI or an invite hook.
// Password auth itself still works — Phase 3 replaces it with invites
// (ADR 0006) and turns passwordAuth off in the same collection.
//
// The rest of the users rules are left alone on purpose: Phase 3 rewrites the
// whole identity story, and a broader change here would be thrown away.
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  users.createRule = null; // superuser only
  app.save(users);
}, (app) => {
  const users = app.findCollectionByNameOrId("users");
  // Back to PocketBase's default for a fresh install. This re-opens public
  // signup: it exists so the schema can be rolled back, not as a safe state.
  users.createRule = "";
  app.save(users);
});
