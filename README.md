# c11n — stakeholder review for web projects

c11n (pronounced "collaboration") lets stakeholders view a web project in
development, ask questions, and leave comments pinned to the exact elements
they're talking about — **without the reviewed site shipping a single line of
c11n code**.

## How it works

A Caddy reverse proxy sits in front of the site under review and injects one
`<script>` tag into every HTML page. That script mounts a Vue 3 overlay
(inside a shadow DOM, so styles never collide) with a comment toolbar, element
pins, and a discussion sidebar. PocketBase stores users, comments, and replies
and pushes realtime updates over SSE.

```
stakeholder ──▶ Caddy proxy (:8080)
                 ├── /               ▶ your site (dev server, preview, staging)
                 │                     + injected <script src="/__c11n/overlay.js">
                 ├── /__c11n/*       ▶ overlay bundle (static)
                 └── /__c11n/pb/*    ▶ PocketBase (auth, comments, realtime SSE)
```

Same-origin by construction: no CORS, no third-party cookies, SSE just works.

## Repo layout

- `packages/overlay/` — Vue 3 overlay, built as a single IIFE bundle
- `deploy/` — Caddy (with `replace-response`) + PocketBase, Docker Compose
- `examples/demo-vue/` — demo Vue Router app to review
- `docs/` — [architecture](docs/architecture.md), [quickstart](docs/quickstart.md)

## Quick start

```bash
cd deploy
cp .env.example .env   # point C11N_UPSTREAM at the site to review
docker compose up --build
# open http://localhost:8080
```

See [docs/quickstart.md](docs/quickstart.md) for user setup and details.

## Development

```bash
asdf install          # nodejs from .tool-versions
npm install
npm run build         # builds packages/overlay → dist/overlay.js
npm test
```

## Status

🚧 Rebooted 2026-08-19 — see `.kilo/plans/2026-08-19-c11n-reboot.md`. The
previous iframe/Go prototype lives in git history before this point.

## License

MIT
