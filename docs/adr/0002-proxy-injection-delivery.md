# ADR 0002: Reverse-proxy injection is the delivery mechanism and the security boundary

**Status:** Accepted 2026-08-19. Re-affirmed 2026-11-25 (Tom), with the
security-boundary framing added.

## Context

There are three ways to get a review overlay onto a site:

1. A `<script>` snippet in the site.
2. A browser extension.
3. A rewriting reverse proxy.

Snippets need changes to the project. Extensions need every client user to
install something. A proxy needs neither. Pastel's commercial product shows
the proxy approach works in practice.

Tom's position (2026-11-25): the proxy also makes it easier to secure the
review with user-based permissions and identity *without altering the
reviewed project*.

## Decision

- Caddy (with `replace-response`) fronts the reviewed site, injects
  `<script src="/__c11n/overlay.js">`, serves the overlay, and proxies
  PocketBase under `/__c11n/pb/`. Everything is same-origin.
- **The proxy is the security boundary.** It authenticates every request,
  including requests for the reviewed site itself, before anything is
  served (ADR 0006). The staging site becomes private to invited users
  without any change to its code.
- There is no snippet or plugin delivery mode. If one is ever needed, the
  only coupling to remove is the hardcoded same-origin `'/__c11n/pb'` base
  URL in `packages/overlay/src/lib/api.ts`.

## What the proxy does and doesn't give us (assessed 2026-11-25)

**It does give us:**

- **Gating the whole site** behind c11n identity (Caddy `forward_auth`). A
  snippet can't do this: it only loads after the page has already been
  served.
- **Keeping identity out of the reviewed app.** The session can live in an
  httpOnly cookie handled at the proxy. The overlay never holds a bearer
  token, so neither the reviewed app's JS nor the third-party scripts it
  loads can read the session and take it elsewhere.
- **Keeping the credential out of the upstream request.** Caddy strips only
  the `c11n_session` cookie from the `Cookie` header it forwards to the
  reviewed app (the app's own cookies pass through untouched), and renames
  an upstream `Set-Cookie: c11n_session=…` to `c11n_blocked=…`, so the
  reviewed server can neither read the session nor replace it. What it does
  receive is `X-C11n-User` and `X-C11n-Role`: an account id and a role, no
  credential. That is an intentional, stable interface — it lets the
  reviewed app personalise itself without knowing anything token-shaped —
  and it is the only identity the proxy hands over.
- **No token-minting routes through the proxy.** `/__c11n/pb/*` answers 403
  to PocketBase's auth endpoints (`auth-refresh`, `auth-with-password`,
  `request-password-reset`, `impersonate/…`, and the rest), which exist only
  to return a bearer token. The overlay uses none of them. Without that
  block, same-origin page JS could have called `auth-refresh` and read a
  token out of the JSON body.
- **Same-origin by construction.** No CORS, and SSE works.

**It does not give us:**

- **Isolation from the reviewed app's own JS.** The overlay runs
  same-origin with the reviewed app. Any script on the page can make
  same-origin requests to `/__c11n/pb/*`, and the browser attaches the
  cookie — so it acts *as* the signed-in user (subject to the collection
  rules) even though it never sees the cookie value and cannot mint a
  token. In-session actions therefore can't be isolated from that app's
  code. The reviewed app, our own project, is **inside** the trust
  boundary. Third-party scripts it loads (analytics, chat widgets) are the
  real residual risk. Fully isolating that would mean serving c11n from a
  separate origin, e.g. an iframe on a sibling host. That is not worth it
  for the dogfood run.
- **Identity inside the reviewed app.** If the staging site has its own
  login, users still sign in to it separately.
- **Simpler permissions.** Who may comment, resolve or delete is enforced
  by backend rules (ADR 0008) whichever way the overlay is delivered.

## Consequences

- The origin changes from the site's real host to the review host. That
  affects cookies with `Domain=`, absolute redirects, OAuth redirect URIs,
  CORS on separate API origins, `<meta>` CSP, service workers and the
  `Host` header. Each has to be checked **against the dogfood site** (plan
  Phase 4). They are not solved in general.
- `tls_insecure_skip_verify` must not be the default (assessment B1, S4).
