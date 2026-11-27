# ADR 0009: The dogfood target is sasser-studios' frontend in Vite dev mode

**Status:** Accepted 2026-11-27 (Tom)

## Context

ADR 0001 says success means dogfooding c11n on one real client project. Tom
named it on 2026-11-27: the `frontend/` app in the `huffduff/sasser-studios`
monorepo (private). It is early-stage. What the repo showed at `5ce4f0b`:

- **Same origin:** yes. In production the Go server (`server/cmd/server`)
  serves `/api/*` and the embedded SPA from one origin. In dev, Vite proxies
  `/api` to the Go server.
- **Own auth:** Zitadel OIDC (`oidc-client-ts` / `zitadel-vue`, PKCE) on a
  separate origin, with bearer tokens to `/api`. The router guard is
  commented out (`auth.useRouter(router)`), so pages render without a login
  today.
- **Service worker:** none.
- **Staging:** none. `infrastructure/` is a Pulumi k3s stack with a `prod`
  stack only; `release.yml` pushes the `server` image to ghcr on `v*` tags.
- **Dev mode is self-contained:** `services/api/index.ts` picks `MockApi`
  when `import.meta.env.DEV`, so `vite --mode development` needs no Go, Mongo
  or Zitadel. Vite serves HTTPS with a self-signed cert (`plugin-basic-ssl`).
- **Production build needs the whole backend:** real API, Mongo with the
  right schema version, Zitadel.
- **Deep links 404 in production:** `http.FileServer` has no `index.html`
  fallback, so a reload on `/members/123` is a 404.

## Decision

- **Review target: Vite dev mode with mock data.** c11n proxies the
  sasser-studios Vite dev server. No backend and no staging environment are
  stood up for the dogfood.
- **App login is out of scope for now.** Reviewers see the app with its
  route guard off, as it is today. No Zitadel redirect URI is registered for
  the review host.
- **The deep-link 404 is the app's bug.** c11n does not paper over it (no
  SPA fallback in our Caddy); it only matters for the Go-served build, which
  we are not reviewing.
- The Phase 4 compat probe runs against a **pinned sasser-studios commit**,
  bumped deliberately, so a change in the app can't turn our CI red
  unannounced.

## Consequences

- Upstream TLS for this target is `C11N_UPSTREAM_TLS=insecure` (self-signed
  Vite cert). That's acceptable for a dev upstream on the same host or pod;
  it is not a pattern for production upstreams.
- HMR (Vite's websocket) has to pass through the proxy.
- sasser-studios is private and c11n is public: CI needs a read-only
  credential to check it out. The CI job is skipped where the credential is
  absent (forks).
- The Go-served topology stays covered by the generic `go` fixture (Task
  1.7), not by the real app. Revisit when sasser-studios has a staging
  environment or turns its route guard on.
