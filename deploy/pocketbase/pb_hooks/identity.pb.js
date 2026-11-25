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

// ---- 3.4: GET /api/c11n/auth/magic — the callback --------------------------
// Public (no auth): the token in the URL is the credential. Caddy rewrites
// /__c11n/auth/magic here in 3.8; until then the route is reached under the
// /__c11n/pb prefix.
//
// Single use is enforced by ONE conditional UPDATE, not by read-then-save:
// `usedAt` is only written when it is still empty, and the affected-row count
// says whether this call won. SQLite serialises writers, so with N parallel
// uses exactly one gets 1 and the rest get 0 — a transaction around
// read+save would instead let several readers see the row unused and then
// collide on the write (SQLITE_BUSY, which surfaces as a 500, not a 410).
//
// Note for anyone editing the SQL: PocketBase stores an unset date as '' (not
// NULL), so `usedAt IS NULL` alone never matches a fresh invite (verified: the
// first version of this route claimed nothing and every link looked unused).
//
// The link is marked used BEFORE the session is minted. If minting then fails
// the link is spent — the safer failure: a retry costs the user one more link,
// while the reverse order would leave a window where a token works twice.
routerAdd("GET", "/api/c11n/auth/magic", (e) => {
  const page = (status) => {
    e.html(
      status,
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        "<title>c11n — link no longer works</title>" +
        "<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#eee;" +
        "font:16px/1.5 system-ui,sans-serif}main{max-width:32rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .75rem}" +
        "p{margin:0;color:#bbb}</style></head><body><main><h1>This link no longer works</h1>" +
        "<p>This link has expired or was already used. Ask your project contact for a new one.</p>" +
        "</main></body></html>"
    )
  }

  const rawToken = (e.request.url.query().get("t") || "").trim()
  if (!rawToken) {
    return page(404)
  }

  let invite = null
  try {
    invite = e.app.findFirstRecordByFilter("invites", "tokenHash = {:h}", { h: $security.sha256(rawToken) })
  } catch (err) {
    // "no rows in result set" — an unknown token is indistinguishable from a
    // deleted one, and both answer the same page.
    invite = null
  }
  if (!invite) {
    return page(404)
  }

  const usedAt = String(invite.get("usedAt") || "")
  const expiresAtMs = new Date(invite.get("expiresAt")).getTime()
  if (usedAt || !(expiresAtMs > Date.now())) {
    return page(410)
  }

  const claimed = e.app
    .db()
    .newQuery("UPDATE invites SET usedAt = {:now} WHERE id = {:id} AND (usedAt IS NULL OR usedAt = '')")
    .bind({ now: new Date().toISOString(), id: invite.id })
    .execute()
  if (claimed.rowsAffected() !== 1) {
    // Someone else won the race between the read above and this write.
    return page(410)
  }

  let user = null
  try {
    user = e.app.findRecordById("users", invite.get("user"))
  } catch (err) {
    user = null
  }
  if (!user) {
    return page(410)
  }

  // Session token: a real PocketBase auth token for the user, minted
  // server-side. `newStaticAuthToken` takes a Go time.Duration, i.e.
  // NANOseconds (a bare 60 is 60ns and mints an already-expired token), and it
  // is non-refreshable — which is what we want: the cookie's lifetime is the
  // session's lifetime, decided here from C11N_SESSION_TTL_DAYS.
  const ttlDays = Number($os.getenv("C11N_SESSION_TTL_DAYS") || "14")
  const token = user.newStaticAuthToken(ttlDays * 86400 * 1000000000)

  // C11N_COOKIE_SECURE defaults to true; the local e2e stack runs over plain
  // http on 127.0.0.1 and stack.sh sets it to false there.
  const secure = ($os.getenv("C11N_COOKIE_SECURE") || "true") !== "false"
  e.setCookie(
    new Cookie({
      name: "c11n_session",
      value: token,
      path: "/",
      maxAge: ttlDays * 86400,
      secure: secure,
      httpOnly: true,
      // 2 is SameSite=Lax (Go's enum: 1 default, 2 lax, 3 strict, 4 none).
      sameSite: 2,
    })
  )

  // `next` is only ever a same-origin path. Absolute URLs, protocol-relative
  // URLs, backslash tricks (browsers treat /\evil as //evil) and schemes all
  // fall back to "/".
  const rawNext = e.request.url.query().get("next") || ""
  const sameOriginPath =
    rawNext.charAt(0) === "/" && rawNext.charAt(1) !== "/" && rawNext.indexOf("\\") === -1 && rawNext.indexOf("://") === -1
  return e.redirect(302, sameOriginPath ? rawNext : "/")
})

// ---- 3.6: session, me and logout ------------------------------------------
// GET  /api/c11n/session       — Caddy forward_auth target (pod-internal when
//                                the gate lands in 3.8)
// GET  /api/c11n/me            — what the overlay calls instead of authRefresh
// POST /api/c11n/auth/logout   — clears the cookie
//
// Every route resolves the user from the cookie the same way, and every route
// rejects anything that is not a `users` record: findAuthRecordByToken(token,
// "auth") happily accepts a `_superusers` token and returns the admin record
// (verified on 0.39.11), so without the collection check an admin token in the
// cookie would be a valid session for the proxy gate.
routerAdd("GET", "/api/c11n/session", (e) => {
  // Manual Cookie parsing: e.request.cookie(name) signals "not found" with an
  // error rather than null, which is awkward to tell apart from a bad token.
  const cookieHeader = e.request.header.get("Cookie") || ""
  let sessionToken = ""
  const parts = cookieHeader.split(";")
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim()
    if (part.indexOf("c11n_session=") === 0) {
      sessionToken = part.slice("c11n_session=".length)
    }
  }

  let user = null
  if (sessionToken) {
    try {
      const record = e.app.findAuthRecordByToken(sessionToken, "auth")
      if (record && record.collection().name === "users") {
        user = record
      }
    } catch (err) {
      user = null
    }
  }

  if (user) {
    e.response.header().set("X-C11n-User", user.id)
    e.response.header().set("X-C11n-Role", String(user.get("role") || ""))
    return e.json(200, { id: user.id, role: String(user.get("role") || "") })
  }

  const accept = String(e.request.header.get("Accept") || "")
  const wantsHtml = accept.indexOf("text/html") !== -1
  if (!wantsHtml) {
    return e.json(401, { message: "no session" })
  }

  // Caddy's forward_auth sets X-Forwarded-Uri to the ORIGINAL request URI; a
  // direct call has no such header, so fall back to this request's own URI.
  let originalUri = String(e.request.header.get("X-Forwarded-Uri") || "")
  if (!originalUri) {
    const rawQuery = String(e.request.url.rawQuery || "")
    originalUri = e.request.url.path + (rawQuery ? "?" + rawQuery : "")
  }
  return e.redirect(302, "/__c11n/auth/?next=" + encodeURIComponent(originalUri))
})

routerAdd("GET", "/api/c11n/me", (e) => {
  let token = ""
  const authorization = String(e.request.header.get("Authorization") || "")
  if (authorization.toLowerCase().indexOf("bearer ") === 0) {
    token = authorization.slice("bearer ".length).trim()
  } else if (authorization) {
    token = authorization.trim()
  }
  if (!token) {
    // Same cookie the session route reads: the overlay's browser sends it.
    const cookieHeader = String(e.request.header.get("Cookie") || "")
    const parts = cookieHeader.split(";")
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim()
      if (part.indexOf("c11n_session=") === 0) {
        token = part.slice("c11n_session=".length)
      }
    }
  }
  if (!token) {
    return e.json(401, { message: "not signed in" })
  }

  try {
    const record = e.app.findAuthRecordByToken(token, "auth")
    if (!record || record.collection().name !== "users") {
      return e.json(401, { message: "not signed in" })
    }
    return e.json(200, {
      id: record.id,
      email: String(record.get("email") || ""),
      name: String(record.get("name") || ""),
      role: String(record.get("role") || ""),
    })
  } catch (err) {
    return e.json(401, { message: "not signed in" })
  }
})

routerAdd("POST", "/api/c11n/auth/logout", (e) => {
  // Max-Age=0 with the same name/path/attributes as the session cookie: a
  // cookie is only cleared when every attribute matches.
  const secure = ($os.getenv("C11N_COOKIE_SECURE") || "true") !== "false"
  e.setCookie(
    new Cookie({
      name: "c11n_session",
      value: "",
      path: "/",
      maxAge: -1,
      secure: secure,
      httpOnly: true,
      sameSite: 2,
    })
  )
  // 204: nothing for the overlay to render; the cookie is the whole response.
  return e.noContent(204)
})
