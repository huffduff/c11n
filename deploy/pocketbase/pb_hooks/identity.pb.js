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
//  - `URL` does NOT exist in the JSVM (`ReferenceError: URL is not defined`,
//    verified here), so "is this the same origin?" has to be spelled out with
//    string checks. See safeNext below.
//  - A function stored in `$app.store()` IS callable from a handler later
//    (verified), while a top-level `const fn = () => {}` is not. That is how
//    the one copy of safeNext is shared instead of duplicated per handler.

// ---- I2: one shared "is this a same-origin path?" validator ----------------
// The old check looked for `//`, a backslash and `://`, which let
// `next=/%09//evil` through: the hook 302s to a Location holding a literal TAB
// and Chromium strips tabs while parsing, so the browser lands on `//evil`.
// CR, LF and NUL behave the same way; a backslash is normalised to `/` by the
// WHATWG parser (`/\evil` -> `//evil`).
//
// Rules, in order: at most 2048 bytes; no C0 control characters or DEL; no
// backslash; starts with exactly one `/` (so no protocol-relative `//`, and no
// absolute URL, which would not start with `/` at all). That is the same set
// `new URL(raw, "https://x.invalid").origin === "https://x.invalid"` accepts
// for a server-side redirect target.
//
// Returning null means "unsafe": callers drop `next` (or fall back to "/")
// rather than redirecting somewhere unvetted.
const safeNext = (raw) => {
  const value = String(raw || "")
  if (!value || value.length > 2048) return null
  if (/[\x00-\x1f\x7f]/.test(value)) return null
  if (value.indexOf("\\") !== -1) return null
  if (value.charAt(0) !== "/") return null
  if (value.charAt(1) === "/") return null
  return value
}
$app.store().set("c11n_safe_next", safeNext)

// ---- configuration, validated once at load (M8) ---------------------------
// The two TTL knobs are read ONCE, here, and fail closed to the production
// default with a stdout warning. A typo must not become a 0-day cookie or a
// 0-hour link: `Number("abc")` is NaN and `newStaticAuthToken(NaN)` is a
// minefield, so the range check is the point, not the parsing.
//
// Top-level values are not in scope inside handlers, so the results go into the
// app store (same mechanism as safeNext) and each handler reads them with a
// local fallback.
const envInt = (name, fallback, min, max) => {
  const raw = $os.getenv(name)
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback
  const value = Number(String(raw).trim())
  if (!isFinite(value) || Math.floor(value) !== value || value < min || value > max) {
    console.log(
      "c11n: ignoring " + name + "=" + raw + " (expected an integer " + min + ".." + max + "), using " + fallback
    )
    return fallback
  }
  return value
}
$app.store().set("c11n_session_ttl_days", envInt("C11N_SESSION_TTL_DAYS", 14, 1, 30))
$app.store().set("c11n_link_ttl_hours", envInt("C11N_LINK_TTL_HOURS", 72, 1, 168))
$app.store().set("c11n_invite_rate_per_hour", envInt("C11N_INVITE_RATE_PER_HOUR", 30, 1, 10000))

// ---- C1: a user cannot change their own privileged fields -----------------
onRecordUpdateRequest((e) => {
  // Superuser is the repair path (the invite route is a hook, not a request,
  // so it is unaffected by this: hook-driven saves do not fire request hooks).
  if (e.hasSuperuserAuth()) {
    return e.next()
  }
  const original = e.record.original()
  // C1 (security review): `users.updateRule` only says `id = @request.auth.id`,
  // so without this hook any signed-in user could PATCH their own record to
  // `{"role":"owner"}` — through the proxy, with nothing but the cookie.
  // `verified` and `email` are closed for the same reason: promoting yourself
  // to a verified account, or moving the record onto someone else's address,
  // are both privilege changes.
  //
  // 400, not 403: a body carrying these fields is a malformed update, and 400
  // is the choice immutable.pb.js makes. Note the ORDER: PocketBase checks the
  // collection rule before this hook, so a guarded field normally answers 404
  // from migration 1764001100's floor; this hook answers 400 when the rule
  // passes the body through (name), and is the guard that still works if the
  // rule is ever relaxed.
  const guarded = ["role", "verified", "email"]
  for (let i = 0; i < guarded.length; i++) {
    const field = guarded[i]
    const before = String(original.get(field) ?? "")
    const after = String(e.record.get(field) ?? "")
    if (before !== after) {
      throw new BadRequestError(field + " cannot be changed by the account itself")
    }
  }
  // `name` stays self-service, but capped: the name is what the audit trail
  // shows, so an 80-byte ceiling keeps one account from impersonating with a
  // 4 KB display name.
  const name = String(e.record.get("name") ?? "")
  if (name.length > 80) {
    throw new BadRequestError("name must be at most 80 characters")
  }
  e.next()
}, "users")

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
  // M9: normalize before e.next(), so PocketBase's own email validation sees
  // the trimmed, lowercased value. The invite route already normalizes its
  // input; this covers the other path (a superuser in the admin UI / the API),
  // and keeps one address from existing in two casings.
  const email = String(e.record.get("email") || "").trim().toLowerCase()
  if (email) {
    e.record.set("email", email)
  }
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

    // M6: per-inviter quota, so one compromised owner/team account cannot mint
    // an unbounded pile of 72-hour links. Counted from `invites` itself
    // (invitedBy + created in the last hour), which is why the spec seeds rows
    // instead of changing the process environment: the env is read at load.
    // Superusers are exempt (break-glass, and the CLI uses it).
    let rateLimit = 30
    try {
      const configured = $app.store().get("c11n_invite_rate_per_hour")
      if (typeof configured === "number") rateLimit = configured
    } catch (err) {
      rateLimit = 30
    }
    // PocketBase stores dates as `YYYY-MM-DD HH:MM:SS.sssZ`; a filter literal
    // with a `T` compares as text and silently matches nothing (verified), so
    // the separator is rewritten.
    const since = new Date(Date.now() - 3600 * 1000).toISOString().replace("T", " ")
    let recent = 0
    try {
      recent = e.app.findRecordsByFilter(
        "invites",
        "invitedBy = {:id} && created >= {:since}",
        "",
        0,
        0,
        { id: caller.id, since: since }
      ).length
    } catch (err) {
      // A failed count must not become a free pass for a normal invite; but it
      // also must not block one. Treat it as zero and let the audit trail show
      // the invites that did get through.
      recent = 0
    }
    if (recent >= rateLimit) {
      return e.json(429, { message: "invite rate limit reached (" + rateLimit + "/hour); try again later" })
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
    // Unusable random password: password auth is disabled (migration
    // 1766000000), but an auth record still needs a password value, and a
    // non-guessable one keeps a rollback from becoming a way in.
    target.setPassword($security.randomStringWithAlphabet(40, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"))
    e.app.save(target)
  }

  // M7: a re-invite revokes the user's older UNUSED links. Otherwise every
  // link ever mailed to that address stays a 72-hour credential, and "send me a
  // fresh link" silently widens the window instead of narrowing it. Runs before
  // the new row is inserted, so it cannot mark the new link used.
  e.app
    .db()
    .newQuery("UPDATE invites SET usedAt = {:now} WHERE user = {:uid} AND (usedAt IS NULL OR usedAt = '')")
    .bind({ now: new Date().toISOString(), uid: target.id })
    .execute()

  let ttlHours = 72
  try {
    const configured = $app.store().get("c11n_link_ttl_hours")
    if (typeof configured === "number") ttlHours = configured
  } catch (err) {
    ttlHours = 72
  }
  // 43 draws from a 64-symbol alphabet: 43 x 6 = 258 bits of entropy (the same
  // string a 32-byte base64url encoding produces). Only the sha256 is stored,
  // so a database dump cannot mint a session.
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
  //
  // The token is in the FRAGMENT, not the query: a fragment is never sent to a
  // server, so neither PocketBase's request log nor the next page's Referer can
  // see it. The sign-in page reads `location.hash` and POSTs the claim.
  const publicUrl = ($os.getenv("C11N_PUBLIC_URL") || "").replace(/\/+$/, "")
  const origin = (e.isTLS() ? "https://" : "http://") + e.request.header.get("Host")
  const link = (publicUrl || origin) + "/__c11n/auth/#t=" + token

  return e.json(200, {
    link: link,
    expiresAt: new Date(invite.get("expiresAt")).toISOString(),
    user: target.id,
    role: role,
  })
})

// ---- 3.4: POST /api/c11n/auth/claim — the single-use claim -----------------
// Public (no auth): the token in the body is the credential. Caddy rewrites
// /__c11n/auth/claim here; the route is also reachable under the /__c11n/pb
// prefix for pod-internal callers.
//
// WHY A POST AND NOT THE GET LINK (I3/4, revised 2026-11-25):
//   - Links are minted as .../__c11n/auth/#t=<token>. A fragment is never sent
//     to any server, so PocketBase's request logger (which stores full URLs for
//     every request) and the Referer header of the page that follows never see
//     the token.
//   - GET is not a safe verb for a single-use action. Slackbot, Outlook Safe
//     Links and every link unfurler GET a pasted link before a human clicks it;
//     when GET was the claim, the unfurler burned the invite. The GET path now
//     only serves the static sign-in page, which asks for a click and then
//     POSTs.
//
// Single use is enforced by ONE conditional UPDATE, not by read-then-save:
// `usedAt` is only written when it is still empty, and the affected-row count
// says whether this call won. SQLite serialises writers, so with N parallel
// claims exactly one gets 1 and the rest get 0 — a transaction around
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
routerAdd("POST", "/api/c11n/auth/claim", (e) => {
  // Every failure is the same answer: 410 with a message, no cookie. The page
  // turns that into the sign-in screen with reason=invalid; the class is in
  // the status, so a script can tell a spent link from a malformed request.
  const fail = (message) => e.json(410, { message: message })

  // CSRF (ADR 0006, revised): the claim is a state-changing POST, so it must
  // only accept a request the sign-in page itself made.
  //   1. Content-Type must be application/json. A cross-site <form> can only
  //      send urlencoded/plain/multipart, and setting a JSON type from script
  //      needs a CORS preflight this route never grants.
  //   2. Origin must be this deployment's own origin, or Sec-Fetch-Site must
  //      say same-origin. Both are browser-controlled; a request with neither
  //      (curl, a server-side GET-forger) is refused.
  // The public origin is C11N_PUBLIC_URL when set (the same value the invite
  // link is built from); otherwise the Host this request arrived with, behind
  // Caddy / the ingress.
  const contentType = String(e.request.header.get("Content-Type") || "").toLowerCase()
  // M-5: compare the MEDIA TYPE exactly. `indexOf("application/json") === 0`
  // also accepted `application/json-patch+json` (and any other `+json`
  // suffix), which is a different content type with different semantics; the
  // route takes plain JSON and nothing else. Parameters (`; charset=utf-8`)
  // are allowed and dropped before the comparison.
  const mediaType = contentType.split(";")[0].trim()
  if (mediaType !== "application/json") {
    return e.json(415, { message: "claim requires application/json" })
  }
  const host = String(e.request.header.get("Host") || "")
  let scheme = e.isTLS() ? "https" : "http"
  const forwardedProto = String(e.request.header.get("X-Forwarded-Proto") || "")
  if (forwardedProto) {
    scheme = forwardedProto.split(",")[0].trim()
  }
  const publicUrl = $os.getenv("C11N_PUBLIC_URL") || ""
  const publicOrigin = publicUrl ? publicUrl.replace(/\/+$/, "") : scheme + "://" + host
  const origin = String(e.request.header.get("Origin") || "")
  const fetchSite = String(e.request.header.get("Sec-Fetch-Site") || "")
  if (!(origin && origin === publicOrigin) && fetchSite !== "same-origin") {
    return e.json(403, { message: "cross-origin claim refused" })
  }

  let body = {}
  try {
    body = e.requestInfo().body || {}
  } catch (err) {
    body = {}
  }
  const rawToken = String((body && body["t"]) || "").trim()
  if (!rawToken) {
    return fail("missing token")
  }

  let invite = null
  try {
    invite = e.app.findFirstRecordByFilter("invites", "tokenHash = {:h}", { h: $security.sha256(rawToken) })
  } catch (err) {
    // "no rows in result set" — an unknown token is indistinguishable from a
    // deleted one, and both answer the same 410.
    invite = null
  }
  if (!invite) {
    return fail("invalid or unknown link")
  }

  const usedAt = String(invite.get("usedAt") || "")
  const expiresAtMs = new Date(invite.get("expiresAt")).getTime()
  if (usedAt || !(expiresAtMs > Date.now())) {
    return fail("link expired or already used")
  }

  const claimed = e.app
    .db()
    .newQuery("UPDATE invites SET usedAt = {:now} WHERE id = {:id} AND (usedAt IS NULL OR usedAt = '')")
    .bind({ now: new Date().toISOString(), id: invite.id })
    .execute()
  if (claimed.rowsAffected() !== 1) {
    // Someone else won the race between the read above and this write.
    return fail("link expired or already used")
  }

  let user = null
  try {
    user = e.app.findRecordById("users", invite.get("user"))
  } catch (err) {
    user = null
  }
  if (!user) {
    return fail("invite has no user")
  }

  // Session token: a real PocketBase auth token for the user, minted
  // server-side. `newStaticAuthToken` takes a Go time.Duration, i.e.
  // NANOseconds (a bare 60 is 60ns and mints an already-expired token), and it
  // is non-refreshable — which is what we want: the cookie's lifetime is the
  // session's lifetime, decided here from C11N_SESSION_TTL_DAYS.
  const ttlDays = (() => {
    try {
      const configured = $app.store().get("c11n_session_ttl_days")
      if (typeof configured === "number") return configured
    } catch (err) {
      // fall through
    }
    return 14
  })()
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

  // `next` is only ever a same-origin path (I2). The one validator lives in
  // the app store because a top-level function is not in scope here; a missing
  // or non-callable value fails closed to "/".
  const rawNext = String((body && body["next"]) || "")
  let next = "/"
  try {
    const validate = $app.store().get("c11n_safe_next")
    if (typeof validate === "function") {
      next = validate(rawNext) || "/"
    }
  } catch (err) {
    next = "/"
  }
  // The page does the navigation: a POST response cannot be a 302 the browser
  // follows without turning the claim into a navigation it might replay.
  return e.json(200, { redirect: next })
})

// ---- 3.6: session, me and logout ------------------------------------------
// (The legacy `GET /api/c11n/auth/magic` route that used to sit here is GONE —
// M-6. deploy/Caddyfile answers /__c11n/auth/magic itself with a static 302 to
// the sign-in page, so an old `?t=` link still explains itself but never
// reaches PocketBase: its request logger stores the full URL, and the hook
// route was writing the token into `_logs` on every open.)
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
  // M-3: this route's answers (200, 401 and the 302 to the sign-in page) are
  // relayed by Caddy's forward_auth, and a cached "you're signed in" answer
  // must never be replayable after the session ends.
  e.response.header().set("Cache-Control", "private, no-store")

  // Manual Cookie parsing: e.request.cookie(name) signals "not found" with an
  // error rather than null, which is awkward to tell apart from a bad token.
  // M-2: the FIRST c11n_session wins and the rest are ignored, matching
  // Caddy's {http.request.cookie.c11n_session} (Go's r.Cookie returns the
  // first match). Iterating to the end let a page set a second cookie and
  // choose which identity the gate validated.
  const cookieHeader = e.request.header.get("Cookie") || ""
  let sessionToken = ""
  const parts = cookieHeader.split(";")
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim()
    if (part.indexOf("c11n_session=") === 0) {
      sessionToken = part.slice("c11n_session=".length)
      break
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
    const role = String(user.get("role") || "")
    // ADR 0008: the agent is API-only. It reads comments through the API and
    // writes tickets/replies, but it must not browse the reviewed site — so an
    // HTML document request is refused while every API request still passes.
    // (forward_auth relays this 403 verbatim; the overlay never loads, which is
    // the point.)
    const agentAccept = String(e.request.header.get("Accept") || "")
    if (role === "agent" && agentAccept.indexOf("text/html") !== -1) {
      return e.json(403, { message: "the agent role is API-only" })
    }
    e.response.header().set("X-C11n-User", user.id)
    e.response.header().set("X-C11n-Role", role)
    return e.json(200, { id: user.id, role: role })
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
  // I2: the URI is attacker-influenced (it is whatever path the browser asked
  // for), so it goes through the same validator as `next` on the magic route.
  // An unsafe value is DROPPED rather than redirected to.
  let safeOriginal = null
  try {
    const validate = $app.store().get("c11n_safe_next")
    if (typeof validate === "function") {
      safeOriginal = validate(originalUri)
    }
  } catch (err) {
    safeOriginal = null
  }
  return e.redirect(
    302,
    "/__c11n/auth/?reason=expired" + (safeOriginal ? "&next=" + encodeURIComponent(safeOriginal) : "")
  )
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
    // M-2: first match only, same as Caddy.
    const cookieHeader = String(e.request.header.get("Cookie") || "")
    const parts = cookieHeader.split(";")
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim()
      if (part.indexOf("c11n_session=") === 0) {
        token = part.slice("c11n_session=".length)
        break
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
  // M5: clearing the cookie is not enough — a copied cookie would keep working
  // for the rest of its 14 days. Rotating the user's `tokenKey` invalidates
  // every auth token ever minted for them ("sign out everywhere"), which is the
  // right blast radius for a session whose bearer may have leaked.
  //
  // Best effort: a missing or already-invalid cookie still gets the clearing
  // Set-Cookie below, because "log out" must always end signed out locally.
  const cookieHeader = String(e.request.header.get("Cookie") || "")
  const parts = cookieHeader.split(";")
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim()
    if (part.indexOf("c11n_session=") === 0) {
      const sessionToken = part.slice("c11n_session=".length)
      try {
        const record = e.app.findAuthRecordByToken(sessionToken, "auth")
        if (record && record.collection().name === "users") {
          record.refreshTokenKey()
          e.app.save(record)
        }
      } catch (err) {
        // Not a live token: nothing to revoke.
      }
      // M-2: only the first c11n_session cookie is the session, so only that
      // one is revoked — a later bogus copy must not stop the revoke.
      break
    }
  }

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
