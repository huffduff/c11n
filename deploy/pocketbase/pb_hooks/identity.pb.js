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

// ---- 3.3: POST /api/c11n/invite — the copy-link invite --------------------
// ADR 0006 MVP: always return the link, never send mail. The inviter passes it
// on through Slack or email, which is why the TTL is hours, not minutes
// (C11N_LINK_TTL_HOURS, default 72).
//
// Role checks are ADR 0008's invite rows: owner may invite owner/team/client,
// team may invite client only, client and agent may not invite. A superuser
// bypasses the table entirely (that is the break-glass path, and what the e2e
// fixtures and the CLI use). The team restriction is enforced twice on purpose:
// on the requested role AND on the role the target user already has, so a team
// member cannot demote (or promote) an existing team/owner account by
// re-inviting it — "a team member can mint a fresh link for an existing user"
// only ever applies to client accounts.
routerAdd("POST", "/api/c11n/invite", (e) => {
  const ROLES = ["owner", "team", "client", "agent"]

  // Superuser first: a superuser request carries no e.auth, but PocketBase can
  // also populate e.auth with the _superusers record, so check the flag and
  // ignore e.auth in that case.
  const isSuperuser = e.hasSuperuserAuth()
  const caller = isSuperuser ? null : e.auth && e.auth.collection().name === "users" ? e.auth : null
  if (!isSuperuser && !caller) {
    return e.json(401, { message: "sign in to invite" })
  }

  const body = e.requestInfo().body || {}
  const email = String(body["email"] || "").trim().toLowerCase()
  const role = String(body["role"] || "").trim()
  if (!email || email.indexOf("@") <= 0) {
    return e.json(400, { message: "a valid email is required" })
  }
  if (ROLES.indexOf(role) === -1) {
    return e.json(400, { message: "role must be one of " + ROLES.join("/") })
  }

  // Find the target user, if it exists. findFirstRecordByFilter throws on "no
  // rows", so the miss is caught rather than tested by count.
  let target = null
  try {
    target = e.app.findFirstRecordByFilter("users", "email = {:email}", { email: email })
  } catch (err) {
    target = null
  }

  if (!isSuperuser) {
    const callerRole = caller.get("role")
    if (callerRole === "owner") {
      // owner: any role, any target
    } else if (callerRole === "team") {
      if (role !== "client") {
        return e.json(403, { message: "team members can only invite clients" })
      }
      if (target && target.get("role") !== "client") {
        return e.json(403, { message: "team members cannot change an existing " + target.get("role") + " user" })
      }
    } else {
      return e.json(403, { message: "your role cannot invite" })
    }
  }

  if (target) {
    if (target.get("role") !== role) {
      target.set("role", role)
    }
    if (!target.get("verified")) {
      target.set("verified", true)
    }
    e.app.save(target)
  } else {
    const users = e.app.findCollectionByNameOrId("users")
    target = new Record(users)
    target.set("email", email)
    target.set("name", email.split("@")[0])
    target.set("role", role)
    target.set("verified", true)
    // Unusable random password: password auth is still enabled until 3.9, and
    // an invited account must not be password-guessable in the meantime. Sign
    // in is by magic link only.
    target.setPassword($security.randomStringWithAlphabet(40, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"))
    e.app.save(target)
  }

  const ttlHours = Number($os.getenv("C11N_LINK_TTL_HOURS") || "72")
  // 32 bytes of entropy, base64url-encoded: 43 chars over a 64-symbol alphabet.
  // Only the sha256 is stored, so a database dump cannot mint a session.
  const token = $security.randomStringWithAlphabet(43, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

  const invites = e.app.findCollectionByNameOrId("invites")
  const invite = new Record(invites)
  invite.set("email", email)
  invite.set("role", role)
  invite.set("user", target.id)
  if (caller) {
    invite.set("invitedBy", caller.id)
  }
  invite.set("tokenHash", $security.sha256(token))
  invite.set("expiresAt", new Date(Date.now() + ttlHours * 3600 * 1000).toISOString())
  e.app.save(invite)

  // C11N_PUBLIC_URL is what a human copies into Slack; without it, fall back to
  // the origin this request came in on, which is right behind Caddy.
  const publicUrl = ($os.getenv("C11N_PUBLIC_URL") || "").replace(/\/+$/, "")
  const origin = (e.isTLS() ? "https://" : "http://") + e.request.header.get("Host")
  const link = (publicUrl || origin) + "/__c11n/auth/magic?t=" + token

  return e.json(200, {
    link: link,
    expiresAt: new Date(invite.get("expiresAt")).toISOString(),
    user: target.id,
    role: role,
  })
})
