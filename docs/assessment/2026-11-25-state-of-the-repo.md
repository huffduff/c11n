# c11n: State of the Repo

_Assessment date: 2026-11-25. Baseline: `main` @ `364a1b1` (last commit 2026-08-22)._

This doc covers three things: (1) the repo and its branches, (2) whether the
reboot plan is realistic and the right approach, and (3) a code triage of what
to keep, fix or delete. The plan for getting the project to success is a
separate doc. It is waiting on the open questions at the end of this one.

**How each claim was checked:**

- **[run]**: I ran it against real binaries: Caddy v2.11.4 with
  `replace-response`, PocketBase 0.39.11, the demo Vite app, and headless
  Chromium driving the built `overlay.js`.
- **[read]**: from reading the source.
- **[unverified]**: a plausible risk I did not test.

Docker is not available in this environment, so the compose stack itself was
not run. Its pieces were run natively with the same configs.

---

## TL;DR

- **The reboot plan was fully executed in one day (2026-08-19).** All 15
  tasks across 4 PRs were merged. Two follow-up changes landed on 2026-08-19
  and 2026-08-20, then nothing for about 3 months.
- **`main` is green in CI but broken at runtime.**
  - The default stack cannot start, because the Caddyfile is rejected for
    the `http://` upstream.
  - Comments cannot be created, because the `seq` hook deadlocks
    PocketBase.
  - CI never catches these because it never runs the stack. All 175 tests
    are jsdom tests with the backend mocked out.
- **Branches:** all 6 non-`main` branches are already merged. Nothing on them
  is unique, so all 6 can be deleted.
- **The code is mostly worth keeping.** The overlay is small (about 1.8k
  lines of TS/Vue plus 500 of CSS), well factored and well commented. Its
  problems are integration bugs, not design rot. Effort should go into an
  end-to-end harness and a short list of fixes, not a rewrite.
- **The approach (proxy injection) is real but narrower than the plan
  admits.** Pastel sells exactly this ("custom proxy technology", no
  snippet). Fronting arbitrary third-party staging sites through a proxy
  brings a class of problems the plan doesn't mention: origin, cookies,
  redirects, OAuth and API CORS. Whether that matters depends on who c11n is
  for. That is the main open question.

---

## Part 1: State of the repo

### Timeline

| Date | What | Who |
|---|---|---|
| 2026-06-26 | Initial prototype: Go chi/WebSocket backend, iframe injection, Vue frontend (`4b3f4ad`, `63919a5`) | Hermes Agent |
| 2026-08-19 | **Reboot.** Legacy code deleted; plan `.kilo/plans/2026-08-19-c11n-reboot.md` executed end to end (PRs #1–#4, 24 commits, 10 of them review fixes) | Agent Foreman / VueDev / Docs |
| 2026-08-19 | `e227a81` straight to `main`: `tls_insecure_skip_verify` on the upstream transport. **This broke `http://` upstreams** (see B1) | tommyo |
| 2026-08-20 | PR #5: persistent per-project `seq` numbers. **This broke comment creation** (see B2) | Agent Architect |
| 2026-08-22 | PR #6: CI runners moved to Blacksmith (bot PR) | blacksmith-sh |
| since | stale | |

### Branches

All remote branches are fully merged into `main` (`git rev-list main..origin/<b>`):

| Branch | Ahead of main | Status | Recommendation |
|---|---|---|---|
| `chore/reboot-workspace` | 0 | merged (#1) | delete |
| `feature/deploy-skeleton` | 1* | merged (#2) | delete |
| `feature/overlay-mvp` | 0 | merged (#3) | delete |
| `feature/demo-ci-docs` | 0 | merged (#4) | delete |
| `feature/persistent-seq-numbers` | 0 | merged (#5) | delete |
| `blacksmith-migration-e7d5695` | 0 | merged (#6) | delete |

\* The one "ahead" commit on `feature/deploy-skeleton` is `51ca157`, a merge
of PR #3 *into* that branch (the PRs were stacked). Its tree is older than
`main`, so it adds no content.

There are no open PRs and no issues. The repo has never used GitHub issues.

The messiness is in the history, not the branches. The stacked PRs were
merged out of order (#3 into #2's branch, #2 into #1's branch, then #1 into
`main`), which tangles the graph. Two commits also went straight to `main`.
None of this hurts the code. It only makes `git log --graph` hard to read.

### Layout and size

```
packages/overlay/   Vue 3 overlay → single IIFE (dist/overlay.js, 152 kB / 52 kB gz)
  src/              ~1,800 lines TS/Vue + 512 lines CSS
  test/             ~3,000 lines, 16 files, 175 tests (vitest + jsdom)
deploy/             Caddyfile, caddy & pocketbase Dockerfiles, compose, 3 migrations, 1 hook
examples/demo-vue/  3-route Vue Router demo app (the default upstream)
docs/               architecture.md, quickstart.md
.kilo/plans/        the 2026-08-19 reboot plan
.github/workflows/  ci.yml (overlay typecheck/build/test + docker image smoke-build)
```

### Health checks (today, local)

| Check | Result |
|---|---|
| `npm ci` (node 24.19.0 via asdf) | ✅ [run] |
| `vue-tsc --noEmit` | ✅ clean [run] |
| `vitest run` | ✅ 175 passed, 1 skipped [run] |
| `vite build` | ✅ single `overlay.js` [run] |
| Last CI on `main` (2026-08-22) | ✅ green, but see below |
| `caddy validate` on `deploy/Caddyfile`, default `http://` upstream | ❌ **fails** [run] |
| Create a comment through the PocketBase API with the shipped hook | ❌ **hangs, and the server's writes stay wedged until restart** [run] |

**Why CI is green:** the `overlay` job tests against a mocked PocketBase SDK.
The `docker` job only runs `docker build`. Neither job starts Caddy or
PocketBase, or loads the overlay in a browser. The comment in `ci.yml` calls a
green docker job "the real verification". It only proves the images build.

---

## Part 2: The plan. Is it realistic? Is it the right approach?

### What the plan set out to do

Deliver "zero-integration stakeholder review". The reviewed site ships no
c11n code. Caddy proxies it and injects the overlay. PocketBase provides
auth, storage and realtime. The overlay is Vue 3 in a shadow DOM. The scope
is v1: one project per compose stack, email/password accounts created by an
admin.

### Was it realistic?

**As a build plan, yes, and it was more than realistic.** It was executed in
full in a day, and the plan itself is good: small tasks, specific decisions,
risks named. Most of its stated risks were handled in code. Examples: CSP
stripping, the `Accept-Encoding: identity` header, orphaned anchors, and the
`flush_interval -1` setting for SSE.

**As a definition of done, no.** The plan's acceptance test was "Task 13
compose stack: Vue SPA reviewed with zero code changes", with e2e tests as a
stretch goal. That acceptance test was never automated, and it apparently
wasn't run by hand after PR #5 either. The result is a codebase whose tests
pass while its two core paths are broken. The plan's gap was verification,
not ambition.

### Is it the right approach?

Each of the three architectural bets, taken separately:

**1. Proxy injection (Caddy + `replace-response`): right mechanism, under-scoped.**

- *Proof it's viable:* Pastel's whole product is "share a link, no snippet,
  no extension", built on its own proxy. BugHerd and Marker.io lead with a
  JS snippet and offer a browser extension as the no-code fallback. Vercel
  Comments is built into its preview toolbar. So the proxy is the one
  approach that is zero-install for *both* the site owner and the
  stakeholder. That is a real differentiator.
- *What the plan didn't account for* (all [unverified] against real
  staging sites, and all known problems for rewriting proxies):
  - **Origin change.** The app runs at `localhost:8080`, or the review
    host, instead of its real origin. Problems that follow:
    - API calls to a separate origin hit CORS allowlists.
    - OAuth/SSO redirect URIs don't match.
    - `Set-Cookie` with `Domain=` or `Secure` doesn't stick on plain http.
    - Absolute `Location:` redirects and absolute links send the user
      *off* the proxy, so the overlay disappears.
  - **Virtual-hosted upstreams** may need `header_up Host {upstream_hostport}`.
    vuejs.org on Netlify worked without it [run]. Other hosts may not.
  - **`<meta http-equiv="Content-Security-Policy">`** in the HTML is not
    stripped. Only the header is.
  - **Service workers** cached from the real origin, and HSTS.
  - **`tls_insecure_skip_verify`** is applied to every upstream. That's a
    reasonable dev convenience, but a bad default for a hosted service.
- For **your own apps on a dev server or a simple static/SSR staging site**,
  the approach works as built. I saw it work on the demo Vue SPA, including
  SPA navigation [run]. For **arbitrary client sites**, it is
  where Pastel spends its engineering budget. **Which of these you're
  targeting decides how much proxy hardening the plan needs. See Q1.**
- *Design note:* the overlay is already a standalone IIFE. Only the
  hardcoded same-origin `'/__c11n/pb'` URL ties it to the proxy. Making
  that URL configurable would cheaply allow a second delivery mode
  (`<script>` snippet or Vite plugin) for apps you control. Whether that's
  wanted is a product question (Q2).

**2. PocketBase as the whole backend: right for v1, with two caveats.**

- It gives auth, realtime and an admin UI for very little code, and the
  `C11nBackend` interface really does contain it: one file, about 240 lines.
- Caveat 1: **the default `users` collection allows public self-signup**.
  Unauthenticated `POST /api/collections/users/records` returned 200 [run].
  With every rule set to `@request.auth.id != ""`, that means **anyone who
  can reach the proxy can create an account and read every comment.** The
  quickstart assumes admin-created users only.
- Caveat 2: this is a single-tenant model, one stack per reviewed site. That
  fits self-hosting. It does not fit a hosted, multi-client service without
  a real `projects` and membership model.

**3. Vue 3 overlay in a shadow DOM: right.** The isolation works: toolbar
and pins rendered cleanly over the demo with no style bleed [run, screenshot].

### Verdict

The approach is sound for a self-hosted, single-team review tool. It is
under-specified for "works on any client's staging site". The gap in the plan
was **verification**: there was no end-to-end gate, so mocks passed while the
product was broken. **Scope** is the second gap, depending on the answer to
Q1. The next plan should make a scripted stack-level e2e test the first
deliverable, not a stretch goal.

---

## Part 3: Code triage. Keep, fix, delete

### Blockers (product doesn't work)

| # | Finding | Evidence | Fix size |
|---|---|---|---|
| **B1** | `deploy/Caddyfile`: `transport http { tls_insecure_skip_verify }` makes Caddy reject any `http://` upstream. That includes the default `http://demo:5173`, so `docker compose up` cannot start Caddy | `caddy validate` → `upstream address scheme is HTTP but transport is configured for HTTP+TLS` [run]; `https://` upstream validates fine | S. Drop it, or gate it behind an env var or a separate site block for https upstreams |
| **B2** | `pb_hooks/comments.pb.js` calls `e.next()` *inside* `e.app.runInTransaction(...)`, but the save in `e.next()` goes through the outer app, not `txApp`. With SQLite's single writer, the comment create request hangs and later writes are blocked until restart | `curl` create → timeout; same request without the hook → 200 [run] | S. Compute `MAX(seq)+1` without the nested transaction (e.g. in `onRecordCreateExecute`; confirm its transaction semantics against the PB 0.39 docs) and rely on the `(project, seq)` unique index plus a retry |
| **B3** | Pins are invisible on page load. `PinLayer` starts the tracker before comments load. When they arrive, `refresh()` re-resolves the targets but never schedules a rect recompute, so pins keep `display:none` until a scroll, resize or DOM mutation | Headless Chromium, `/`: pin `display:none`; after a viewport resize: `left: 940px; top: 100px` [run] | S. Schedule a recompute when the target set changes (expose `tracker.refresh()`) |
| **B4** | Duplicate pin after saving a comment. The realtime `create` event can arrive before the HTTP response. `upsertFromRealtime` adds the record, then `saveComment` `push`es it again with no dedupe | 1 row in the DB, 2 pins rendered (`['0','0']`) [run] | XS. Upsert by id in `saveComment` |

### Security and correctness (fix before anyone else uses it)

| # | Finding | Evidence |
|---|---|---|
| S1 | Public self-signup on `users` plus "any authenticated user reads everything" means an open read | [run] |
| S2 | `comments.updateRule` lets a non-author change `seq` (the rule's blocklist misses it) and lets the author reassign `author` to someone else, who can then delete it | bob set `seq=999` → 200; author → bob, then bob DELETE → 204 [run] |
| S3 | `replies` realtime is subscribed unscoped (`'*'`), so a client receives every reply in every project | [read] `api.ts`. Harmless at one project; a leak at many |
| S4 | `tls_insecure_skip_verify` on all upstreams, and the PocketBase image `ADD`s a zip with no checksum. `caddy:2` / `caddy:2-builder` are unpinned | [read] |

### Doc and code drift

- `docs/architecture.md` says "the reviewed DOM is never mutated". In fact
  `picker.ts` sets an inline `outline` on hover, and `Sidebar.vue` sets an
  inline `outline` to flash. The code has a `TODO(Task 11)` admitting this,
  and Task 11 never did it.
- The plan text still says Node 22 in places; `.tool-versions` says 24.19.0.
- Pins render at `rect.right + 4px`, so a pin on a full-width element lands
  off-screen [read]. This is UX polish, not a blocker.
- The pocketbase SDK is `^0.27` against server 0.39.11. The parts used
  worked [run], but the versions should be pinned together on purpose.

### Keep / fix / delete

**Keep as is (solid, tested, small):**

- `lib/url.ts`: normalization and the SPA nav hook. It handled Vue Router
  push and back correctly in the browser [run].
- `lib/anchor.ts`: finder plus a text fallback. Orphans rather than guessing.
- `lib/tracker.ts`: one rAF-coalesced tracker. Needs the B3 hook only.
- `lib/api.ts` / `lib/backend.ts` / `lib/types.ts`: the swap boundary is
  clean.
- `main.ts`, the shadow-DOM mount, the Vite IIFE build.
- `stores/session.ts`, `LoginPanel.vue`, `Toolbar.vue`, `Composer.vue`,
  `ThreadPopover.vue`, `Sidebar.vue`, plus the B4 fix.
- Migrations `…000_init` and `…001_seed`, apart from the S2 rule fixes.
- `examples/demo-vue`: a fine fixture for the e2e harness.

**Fix (listed above):** `Caddyfile` (B1, S4), `pb_hooks/comments.pb.js` (B2),
`PinLayer.vue` (B3), `stores/comments.ts` (B4), migrations and rules (S1–S3),
`picker.ts` and `Sidebar.vue` highlight (doc drift), and `ci.yml` (add the
stack e2e job).

**Delete:**

- All 6 merged remote branches.
- `test/mount-dist.spec.ts`'s silent auto-skip when `dist/` is absent.
  Make it fail, or keep it only in the build-then-test CI order.
- `.kilo/plans/2026-08-19-c11n-reboot.md` should be **archived, not
  deleted**: move it to `docs/history/` with a "superseded by" line once the
  new plan lands. Nothing else is dead weight. The legacy Go/iframe code is
  already gone from the tree.

**Rewrite:** nothing. Specifically, don't rewrite the overlay. The bugs are
narrow, and the 3k lines of tests are useful, though mock-heavy.

### On the tests

There are 175 tests and they are well written. All of them stop at the
`C11nBackend` mock or at jsdom. jsdom has no layout, so `getBoundingClientRect`
is all zeros and B3 can't show up. The mocked backend never emits realtime
events before the HTTP response returns, so B4 can't show up. The missing
layer is a scripted run of PocketBase, Caddy, the demo app and headless
Chromium. I built a rough version of that harness for this assessment; it
found B1–B4 in under an hour. Promoting it into the repo and CI is the
highest-leverage next step.

---

## Open questions (they block the success plan)

1. **Who is c11n for?** For example: your own team reviewing your own apps,
   an agency reviewing client sites, an open-source self-host tool, or a
   hosted product. This sets how much proxy hardening is needed (origin,
   cookies, OAuth) and whether multi-tenant matters.
2. **Is proxy-only a hard requirement?** Or is an opt-in `<script>`/Vite
   plugin mode acceptable for sites you control? The overlay is nearly ready
   for that already.
3. **How should stakeholders get access?** Admin-created accounts (today),
   invite or magic links, or guest name-only commenting (Pastel and BugHerd
   allow guests). This decides the S1 fix.
4. **Deployment target:** one compose stack per reviewed site, one stack
   serving many sites by subdomain, or a managed service?
5. **What does "success" mean, and by when?** For example: dogfood on a
   real project, first external user, public launch.
6. **Housekeeping consent:** may I delete the 6 merged remote branches?
   Should this doc go up as a PR now, or together with the plan?
