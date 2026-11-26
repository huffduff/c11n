# ADR 0006: Passwordless invites and magic links, with an httpOnly session enforced at the proxy

**Status:** Accepted 2026-11-25 (Tom). Tom's brief was: "Invite/magic links
are fine as long as user identity is secure. Open to suggestions for best
UX/DX." This ADR was the suggestion, and Tom accepted it.

**Revised 2026-11-25 (security review).** Three changes, all in the claim path:
the link TTL is 72 h (not 15 min) because the MVP is copy-the-link; the token
lives in the URL **fragment** and is claimed by a same-origin **POST**, so link
unfurlers, request logs and `Referer` never see it; and the claim endpoint
requires `Content-Type: application/json` plus a same-origin `Origin` /
`Sec-Fetch-Site`. Status stays Accepted.

**MVP scope (Tom, 2026-11-25): copy-the-link only.**
- `POST /api/c11n/invite` always returns the link. The inviter passes it on
  through Slack, email or similar.
- Re-requesting a link from the sign-in page has no email channel, so in the
  MVP it shows "Ask your project contact for a new link." A team member can
  generate a fresh link for an existing user.
- Sending invite and re-request emails over SMTP is **post-MVP**. When it
  lands, it is configured through `C11N_SMTP_*` and nothing else in this
  design changes.

## Context

- Today's model has admin-created email/password accounts, entered in an
  overlay login form. The PocketBase token is kept in `localStorage`, where
  every script on the reviewed page can read it. Public signup is also
  accidentally open (assessment S1).
- Client users are external and occasional. Passwords are friction for
  them, and a support burden for us.

## Decision

### UX

1. An owner or team member invites people by email from the overlay
   ("Invite" in the sidebar) or with the CLI (`c11n invite <email> --role
   client`).
2. The invitee gets an email with a link to
   `https://<review-host>/__c11n/auth/#t=<token>`.
3. Clicking the link opens a one-button "Continue to review" page; the click
   signs them in and drops them on the page they were invited to. There is no
   password and no form, and a plain GET of the link never signs anyone in.
4. When a session expires, any request shows a branded c11n sign-in page.
   The user enters their email and gets a new link, but **only if they
   were invited**. Unknown emails get the same "check your inbox" response
   and no email, so the page doesn't reveal who is invited.

### Mechanics (PocketBase hooks + Caddy)

- `users.createRule = null`. Nobody can sign themselves up.
- Password auth is disabled on `users`.
- A new `invites` collection holds email, role, inviter, a token hash,
  `expiresAt` and `usedAt`. Superusers and hooks only.
- `POST /api/c11n/invite` (hook route) checks the caller's role. It creates
  or updates the user and the invite, and sends the email through
  PocketBase's SMTP settings. **If SMTP isn't configured, it returns the
  link** so the inviter can pass it on through Slack or similar.
- **Public auth paths** all sit under `/__c11n/auth/`. That prefix is the
  only one exempt from the gate:
  - `/__c11n/auth/` is the static sign-in page (also the "Continue" page).
  - Caddy rewrites `/__c11n/auth/{claim,logout}` to the PocketBase hook
    routes `/api/c11n/auth/{claim,logout}`. The old `/__c11n/auth/magic`
    path is answered by Caddy itself with a static 302 to the sign-in page
    (`reason=legacy`) and never reaches PocketBase: its request logger
    stores the URL, so a hook route there kept the `?t=` token in `_logs`
    (removed 2026-11-26). Links minted before this revision still explain
    themselves, and an unfurler cannot spend them.
- `POST /__c11n/auth/claim` takes `{t, next}` as JSON, checks the token hash,
  the expiry (72 h, `C11N_LINK_TTL_HOURS`, single use) and the user. It then
  issues a PocketBase auth token, sets **`c11n_session`**: `HttpOnly; Secure;
  SameSite=Lax; Path=/`, lifetime 14 days (`C11N_SESSION_TTL_DAYS`), and
  answers `{redirect: "<same-origin path>"}`; the page navigates there.
  `next` must be a same-origin path (no control characters, no backslash,
  exactly one leading `/`, ≤ 2048 bytes).
- **Why a fragment and a POST (2026-11-25).** A fragment is never sent to a
  server, so the token cannot land in PocketBase's request log or in the
  `Referer` of the next page. And GET is not a safe verb for a single-use
  action: Slackbot, Outlook Safe Links and similar unfurlers GET every pasted
  link, which under the old design burned the invite before the human clicked
  it. The GET now only serves the page; the claim is the POST the button makes.
  CSRF is closed by requiring `Content-Type: application/json` (a cross-site
  form cannot send it, and scripted cross-origin JSON needs a CORS preflight)
  and `Origin` equal to the deployment's public origin, or
  `Sec-Fetch-Site: same-origin`.
- `POST /__c11n/auth/request` serves the "send me a new link" form,
  rate-limited per email and per IP. This is post-MVP; it needs SMTP.
- `GET /api/c11n/session` is the `forward_auth` target. Caddy calls it on
  the pod-internal PocketBase address; it is not a public path. It returns 200 with
  `X-C11n-User` for a valid cookie. Otherwise it sends a 302 to the sign-in
  page for HTML requests and a 401 for everything else.
- **Caddy:**
  - `forward_auth` covers **every** route (the reviewed site, `/__c11n/*`
    and `/__c11n/pb/*`) except `/__c11n/auth/*`.
  - For `/__c11n/pb/*` Caddy sets `header_up Authorization
    {http.request.cookie.c11n_session}`. The PocketBase SDK in the overlay
    never holds a token.
  - Any client-sent `Authorization` header is overwritten.
- The overlay drops the password login. `backend.me()` calls
  `GET /api/c11n/me`.
- **Agents** (if ADR 0008 adds them): a long-lived token from the
  PocketBase impersonate API, minted by an owner. It is used on a
  *separate* hostname or path that accepts bearer tokens only, so agent
  credentials never travel as cookies.

These PocketBase capabilities were verified on 0.39.11 (2026-11-25):

- `routerAdd` and `e.setCookie` work in JS hooks.
- OTP support exists but is disabled by default.
- The `impersonate` endpoint exists.
- The default `users.createRule` is `""` (public signup open).

## Why not PocketBase's built-in OTP or password auth as is

Both return a bearer token to JS, which then has to be stored where page
scripts can read it. The proxy-held httpOnly cookie is what makes identity
"secure" in the sense Tom asked for (ADR 0002).

## Consequences

- **Every** page of the staging site requires sign-in. That is intentional:
  the staging site becomes private.
- The reviewed app stays inside the trust boundary for in-session actions
  (ADR 0002). That residual risk is documented and accepted for the dogfood
  run.
- SMTP is needed for the best UX. The copy-the-link fallback keeps it
  optional.
- Because the link is copied by hand, its TTL is 72 h rather than 15 min. A
  copied link is therefore a 72-hour bearer for one sign-in; re-inviting the
  same user revokes the older unused links, and logout revokes every session
  token for that user (`tokenKey` rotation).
- The PocketBase admin UI (`/_/`) must not be exposed through the review
  host. Reach it with port-forward, or on a separate, restricted ingress.
