# packages/signin

The static sign-in page served at `/__c11n/auth/` (ADR 0006). No framework,
no build step: `index.html` and `signin.css` are the whole thing.

## This directory is PUBLIC

`C11N_SIGNIN_DIR` is mounted straight into Caddy's `file_server` under
`/__c11n/auth/*`, and that route is deliberately outside the session gate:
an unauthenticated visitor is exactly who the page is for. **Everything in
this directory is served to anonymous visitors.** Put nothing here that you
would not publish — no source maps, no `.env`, no notes, no build output.
That includes this README: `/__c11n/auth/README.md` is reachable.

## How it works

- A magic link arrives as `/__c11n/auth/#t=<token>`. A URL fragment never
  leaves the browser, so no server (and no request log) sees the token.
- The page reads the fragment, then immediately calls
  `history.replaceState` to drop `#t=` from the address bar, so the
  credential cannot end up in a screenshot, bookmark or synced history.
- The visitor clicks "Continue to review", which POSTs the token, as JSON,
  to `/__c11n/auth/claim`. That route mints the httpOnly `c11n_session`
  cookie. A GET never claims anything, so link unfurlers (Slackbot, Outlook
  Safe Links) cannot burn an invite.
- Every response from `/__c11n/auth/*` carries `Cache-Control: private,
  no-store` (set in `deploy/Caddyfile`); do not rely on the file server's
  defaults if you add a route.

## Reasons

`?reason=` picks the copy: `expired` (the default), `signed-out`,
`invalid`, `legacy`. `legacy` is what `/__c11n/auth/magic?t=…` redirects to
— that route never reaches PocketBase, because its request logger would
store the token from the URL.
