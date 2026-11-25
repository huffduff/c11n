/// <reference path="../pb_data/types.d.ts" />

// C1 (security review) — the rule-level floor on `users.updateRule`.
//
// PocketBase's default for an auth collection is `id = @request.auth.id`: any
// signed-in user may PATCH their own record, including `role`. The primary
// guard is `pb_hooks/identity.pb.js` (onRecordUpdateRequest on `users`), which
// compares the stored row and answers 400. This migration is the backstop for
// the deployment that ships migrations but forgets pb_hooks, which is the
// scenario scripts/check-rule-floor.mjs boots on purpose.
//
// `@request.body.X:isset = false` is a body blocklist: it refuses a PATCH that
// MENTIONS role, email or verified at all, regardless of the value. It cannot
// see the stored row, which is why the hook (exact comparison) exists, and it
// cannot stop a client echoing an unchanged value back — also the hook's job.
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  users.updateRule =
    "id = @request.auth.id && " +
    "@request.body.role:isset = false && " +
    "@request.body.email:isset = false && " +
    "@request.body.verified:isset = false";
  app.save(users);
}, (app) => {
  const users = app.findCollectionByNameOrId("users");
  // Back to PocketBase's default. This re-opens self-promotion — it exists so
  // the schema can be rolled back, not as a safe state.
  users.updateRule = "id = @request.auth.id";
  app.save(users);
});
