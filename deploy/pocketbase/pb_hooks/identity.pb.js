// pb_hooks/identity.pb.js
// Identity for c11n: roles, invites, magic links and the proxy session
// (ADR 0006, ADR 0008). Phase 3 task 3.1 starts here with the role default;
// 3.3, 3.4 and 3.6 add the hook routes below it.
//
// JSVM facts this file is written around, all verified on 0.39.11 (see
// .stack/pb_data/types.d.ts after a `scripts/stack.sh up`):
//
//  - A top-level `function` is NOT in scope inside a handler that runs later
//    (each .pb.js file gets its own scope pool). Calling one throws a
//    ReferenceError, which PocketBase surfaces as a bare 400. Every helper is
//    therefore inlined into the handler that uses it.
//  - Request hooks must call `e.next()`; without it PocketBase answers 200 and
//    silently does nothing.
//  - `e.hasSuperuserAuth()` is the only reliable superuser test: a superuser
//    request carries no `@request.auth` record, so rule strings never see it.
//  - `$app.findAuthRecordByToken(token, "auth")` ALSO accepts a `_superusers`
//    token and returns that record (verified here), so every token check has
//    to assert `record.collection().name === "users"` as well.
//  - `record.newStaticAuthToken(n)` takes a Go time.Duration, i.e. NANOseconds:
//    `newStaticAuthToken(60)` is a token that expired 60ns after minting, and
//    `findAuthRecordByToken` rejects it with "token is expired".

// ---- 3.1: role default ----------------------------------------------------
// `users.role` is a required select (migration 1764001000) and PocketBase
// select fields have no default value, so new users get `client` here —
// the least privileged role, per ADR 0008. The invite route (3.3), the
// bootstrap owner (3.2) and the admin UI all set `role` explicitly before
// save; this only covers the paths that set nothing (the e2e fixtures, and a
// superuser creating a user in the admin UI).
//
// This is deliberately NOT a rule: a rule string can require a value but
// cannot supply one, and `users.createRule = null` (migration 1764000000)
// means only a superuser or a hook creates users at all.
onRecordCreateRequest((e) => {
  if (!e.record.get("role")) {
    e.record.set("role", "client")
  }
  e.next()
}, "users")
