/// <reference path="../pb_data/types.d.ts" />

// Phase 3, task 3.9 — no password exists anywhere (ADR 0006).
//
// The overlay's password form is gone, users are created only by the invite
// route (or a superuser), and sign-in is the magic link that sets the httpOnly
// c11n_session cookie. Turning `passwordAuth` off closes the last path that
// could mint a bearer token for JS to hold: `auth-with-password` starts
// answering 400, so a leaked/guessed password can never become a session.
//
// Deliberately the last migration in this batch: bootstrap.pb.js and the invite
// route both set an unusable random password on new accounts (`setPassword` is
// how PocketBase creates a valid auth record), and the e2e fixtures create
// users as superuser. Neither path authenticates with a password, so disabling
// it changes only what an attacker can do.
//
// The `password` field stays in the schema: PocketBase requires it for auth
// records, and the superuser collection itself still uses password auth
// (that is the break-glass admin path, reached with port-forward, not exposed
// on the review host — /__c11n/pb/_/ answers 404 through Caddy).
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  users.passwordAuth.enabled = false;
  app.save(users);
}, (app) => {
  // Re-enabling is itself a rollback hazard: every account created by an
  // invite holds a random unusable password, so this does not hand anyone a
  // working credential — it only restores the endpoint.
  const users = app.findCollectionByNameOrId("users");
  users.passwordAuth.enabled = true;
  app.save(users);
});
