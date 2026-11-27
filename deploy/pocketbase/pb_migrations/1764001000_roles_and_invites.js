/// <reference path="../pb_data/types.d.ts" />

// Phase 3, task 3.1 — roles on `users` and the `invites` collection
// (ADR 0008 for the roles, ADR 0006 for the invites).
//
// `role` is a required select. A PocketBase select field has no default, so
// "default client" is applied by `pb_hooks/identity.pb.js`
// (onRecordCreateRequest sets `client` when the caller set nothing — the
// fixtures, the admin UI and the invite route all rely on it).
//
// Existing rows are backfilled to `team`. Every account that exists before
// this migration was created by an admin for our own people; client accounts
// only ever arrive through an invite. The backfill is also load-bearing: a
// required select left empty on an existing row makes every later PATCH of
// that record fail validation.
//
// `passwordAuth` is deliberately NOT disabled here. The overlay still signs in
// through its password form, and `e2e/fixtures.ts loginAs` drives that form.
// Task 3.9 replaces the form with the cookie session, and flipping
// `passwordAuth` off belongs in the same batch — disabling it now would lock
// every existing e2e spec out of the stack, and there would be no way in at
// all (public signup has been closed since migration 1764000000).
//
// `invites` is hooks-and-superusers only: all five API rules are null. The
// token hash must never be listable, and an invite row is a bearer artefact —
// creating one is the invite route's job, not a client's.
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");

  users.fields.add(
    new Field({
      type: "select",
      name: "role",
      required: true,
      maxSelect: 1,
      values: ["owner", "team", "client", "agent"],
    })
  );
  app.save(users);

  // Before the collection can validate a full record again (a superuser PATCH,
  // the invite route touching an existing user), the rows need a value.
  app
    .db()
    .newQuery("UPDATE users SET role = 'team' WHERE role IS NULL OR role = ''")
    .execute();

  const invites = new Collection({
    type: "base",
    name: "invites",
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [
      // Kept separately from the relation: the invite outlives a deleted user
      // so the audit trail ("who was invited") survives, and the email is what
      // a re-invite looks up before the user row exists.
      { type: "text", name: "email", required: true },
      {
        type: "select",
        name: "role",
        required: true,
        maxSelect: 1,
        values: ["owner", "team", "client", "agent"],
      },
      {
        type: "relation",
        name: "invitedBy",
        collectionId: users.id,
        maxSelect: 1,
        cascadeDelete: false,
      },
      {
        type: "relation",
        name: "user",
        required: true,
        collectionId: users.id,
        maxSelect: 1,
        cascadeDelete: true,
      },
      // sha256 hex of the magic token. The raw token exists only in the link
      // that the inviter copies; a database read cannot mint a session.
      { type: "text", name: "tokenHash", required: true },
      { type: "date", name: "expiresAt", required: true },
      // Set in the same transaction that mints the session; a non-empty value
      // means the link is spent.
      { type: "date", name: "usedAt" },
      { type: "autodate", name: "created", onCreate: true },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
    ],
    indexes: [
      // One live row per hash; the lookup in the magic-link route is by hash.
      "CREATE UNIQUE INDEX idx_invites_token_hash ON invites (tokenHash)",
      "CREATE INDEX idx_invites_user ON invites (user)",
    ],
  });
  app.save(invites);
}, (app) => {
  // Children first, then the field: the invites relation points at `users`,
  // and dropping the field under a live relation leaves a dangling index.
  app.delete(app.findCollectionByNameOrId("invites"));

  const users = app.findCollectionByNameOrId("users");
  users.fields.removeByName("role");
  app.save(users);
});
