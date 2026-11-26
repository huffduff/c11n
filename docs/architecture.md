# c11n Architecture

_Last updated: 2026-11-26. This is an overview. The authoritative decisions
live in [`docs/adr/`](adr/README.md). Where this page and an ADR disagree,
the ADR wins. Current state and known bugs:
[`docs/assessment/2026-11-25-state-of-the-repo.md`](assessment/2026-11-25-state-of-the-repo.md)._

> **Pending changes:**
> - Production hosting is one Helm release per site; compose is for dev
>   only (ADR 0005).
> - Identity (Phase 3) and roles (ADR 0008) are built and covered by e2e; see
>   **Identity and access** below. Email delivery of invites is post-MVP
>   (plan task 3.11): links are copied, not mailed.

## Problem

Stakeholders need to view a web project in development, ask questions, and
leave comments anchored to what they see. The reviewed site must not require
any integration code.

## Solution overview

Three components, composed at deploy time:

```
stakeholder ──▶ Caddy proxy (:8080)
                 ├── /               ▶ reviewed site (any HTML upstream)
                 │                     + injected <script src="/__c11n/overlay.js">
                 ├── /__c11n/*       ▶ overlay bundle (static files)
                 └── /__c11n/pb/*    ▶ PocketBase (auth, data, realtime SSE)
```

### 1. Caddy reverse proxy (delivery)

Caddy 2 built with the official
[`caddyserver/replace-response`](https://github.com/caddyserver/replace-response)
plugin rewrites `</head>` → `<script src="/__c11n/overlay.js" defer></script></head>`
in proxied HTML responses. No custom Caddy plugin code.

- Works against any upstream that serves HTML: Vite dev server, preview
  build, staging deployment. Framework-agnostic; Vue is simply the first
  target we demo.
- `header_up Accept-Encoding identity` is **load-bearing**: the replacer
  matches plaintext, so the upstream must not compress.
- Everything is same-origin behind the proxy: no CORS, no third-party
  cookie problems, SSE works unmodified.
- Upstream CSP headers are stripped on proxied responses (this tool fronts
  staging/review environments, not production).

### 2. PocketBase (backend, v1)

One binary provides SQLite storage, admin UI, realtime SSE subscriptions and
JS hooks — including the identity hooks in `pb_hooks/identity.pb.js` that mint
magic-link sessions. Password auth on `users` is off. Schema lives as JS
migrations in `deploy/pocketbase/pb_migrations/` (schema-as-code).

Collections:

| Collection | Fields | Notes |
|---|---|---|
| `projects` | name, slug (unique), upstream | one row per reviewed site; v1 seeds `default` |
| `comments` | project→projects, seq (number), path, selector, anchorMeta (json), body, author→users, resolved | thread roots, anchored to a DOM element on a normalized path with persistent sequence numbers |
| `replies` | comment→comments (cascade), body, author→users | flat replies; no nesting (YAGNI) |

API rules: per the ADR 0008 matrix as built in migration `1766000100` —
`owner`/`team` resolve and delete any comment, `client` creates and manages its
own, `agent` is API-only (the session route answers 403 to an HTML document
request for that role).

**Swap escape hatch:** the overlay talks to the backend exclusively through
the `C11nBackend` interface in `packages/overlay/src/lib/api.ts` (8 methods +
subscribe). Replacing PocketBase with a custom Go server means writing one new
implementation of that interface — nothing else in the overlay changes.

### Identity and access

Passwordless, proxy-enforced (ADR 0006; roles per ADR 0008):

- **Invite → link.** An owner or team member calls `POST /api/c11n/invite`
  and gets a copy-link (`/__c11n/auth/#t=<token>`, TTL in hours). Nothing is
  emailed in the MVP. Only the token's sha256 is stored, links are single
  use, and re-inviting revokes the older unused links.
- **Claim.** The static sign-in page reads the fragment (never sent to a
  server), immediately drops it from the address bar, and on a click POSTs it
  as JSON to `/__c11n/auth/claim` (Origin / Sec-Fetch-Site checked; a GET never
  claims, so unfurlers cannot burn an invite). The route mints a non-refreshable
  PocketBase token in an httpOnly, SameSite=Lax `c11n_session` cookie.
- **Gate.** Caddy `forward_auth`s every route except `/__c11n/auth/*` to
  `/api/c11n/session`, copies `X-C11n-User` / `X-C11n-Role` on success, relays
  the hook's 302 (HTML) or 401 (API) on failure. On `/__c11n/pb/*` Caddy
  injects `Authorization` from the cookie, so page JS never holds a token;
  password auth is off and PocketBase's token-minting auth routes
  (`auth-refresh`, `auth-with-password`, `impersonate/…`, …) answer 403 at the
  proxy so page JS cannot mint one either.
- **Upstream isolation.** The reviewed app's `Cookie` header arrives without
  `c11n_session` (only that one cookie is stripped), and an upstream
  `Set-Cookie: c11n_session=…` is renamed to `c11n_blocked=…`, so the upstream
  can neither read nor replace the session. It does get `X-C11n-User` and
  `X-C11n-Role`: an id and a role, no credential (ADR 0002).
- **Cacheability.** `/__c11n/auth/*`, `/__c11n/pb/*` and the gate's answers
  are `Cache-Control: private, no-store`.
- **Sign-out** posts `/__c11n/auth/logout`, which clears the cookie *and*
  rotates the user's `tokenKey` — signing out everywhere. Any 401 from any
  overlay request (an expired cookie, or a sign-out in another tab) routes the
  page to the sign-in screen.

### 3. Overlay (Vue 3, shadow DOM)

Single IIFE bundle (`overlay.js`) built by Vite lib mode. Mounts into a
`<div id="c11n-root">` with `attachShadow({mode:'open'})`; all CSS is injected
into the shadow root so the reviewed app's styles and ours cannot collide.
The reviewed DOM must never be mutated (ADR 0004). **Known violation:** the
picker hover and the sidebar flash currently set an inline `outline` on the
target element. Plan task 6.1 fixes this.

Key mechanics:

- **Anchoring:** comments store a unique CSS selector generated by
  [`@medv/finder`](https://github.com/antonmedv/finder) plus fallback metadata
  `{tag, text, rect}`. Resolution tries the selector, then a tag+text scan;
  unresolvable anchors surface as "orphaned" in the sidebar instead of
  disappearing.
- **Page identity:** comments key on normalized `pathname + sorted query`
  (hash stripped, tracking params removed). Origin-independent because the
  proxy host is not identity.
- **SPA support:** `history.pushState`/`replaceState` are wrapped and
  `popstate` observed, so client-side navigation (Vue Router et al.) reloads
  pins without page reloads.
- **Realtime:** PocketBase `subscribe()` on `comments`/`replies` keeps all
  connected reviewers in sync.
- **Positioning:** [`@floating-ui/dom`](https://floating-ui.com/) for
  composer/popover placement; pins reposition on scroll/resize/mutation via a
  rAF-throttled observer.

## Decisions log

| # | Decision | Alternatives considered | Why |
|---|---|---|---|
| 1 | Revive `c11n` repo in place | new repo | history preserved; same concept |
| 2 | PocketBase now, custom Go later if needed | evolve old chi/WS skeleton | auth+storage+realtime for free; swap contained by `C11nBackend` |
| 3 | Caddy `replace-response` injection | custom Caddy plugin, Vite plugin, iframe (old design) | zero plugin code; works on any deployed site; iframe had cross-origin walls |
| 4 | Shadow-DOM overlay | style-prefixed global CSS | hard isolation, no bleed either direction |
| 5 | `@medv/finder` for selectors | hand-rolled walker (old prototype) | battle-tested, unique-by-construction |
| 6 | npm workspaces monorepo | separate repos | overlay + deploy + demo version together |

## Deferred (deliberately)

- Guest/name-only commenting (v1: PocketBase accounts only)
- Screenshot capture with comments
- Multi-project routing on one proxy
