# ADR 0006: Passwordless invites and magic links, with an httpOnly session enforced at the proxy

**Status:** Accepted 2026-11-25 (Tom). Tom's brief was: "Invite/magic links
are fine as long as user identity is secure. Open to suggestions for best
UX/DX." This ADR was the suggestion, and Tom accepted it.

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
   `https://<review-host>/__c11n/auth/magic?t=<token>`.
3. Clicking the link signs them in and drops them on the page they were
   invited to. There is no password and no form.
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
  - `/__c11n/auth/` is the static sign-in page.
  - Caddy rewrites `/__c11n/auth/{magic,request,logout}` to the PocketBase
    hook routes `/api/c11n/auth/{magic,request,logout}`.
- `GET /__c11n/auth/magic?t=…` checks the token hash, the
  expiry (15 min, single use) and the user. It then issues a PocketBase auth
  token and sets **`c11n_session`**: `HttpOnly; Secure; SameSite=Lax;
  Path=/`, lifetime 14 days. Finally it 302s to the `next` path, which must
  be a same-origin path.
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
- The PocketBase admin UI (`/_/`) must not be exposed through the review
  host. Reach it with port-forward, or on a separate, restricted ingress.
