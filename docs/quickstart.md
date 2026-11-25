# Quickstart

Get `c11n` running in front of your web application for stakeholder review.

Reviewers never see a password, a sign-up form or an admin screen. Identity is
an invite link that signs you in and sets an httpOnly session cookie, and Caddy
checks that cookie on **every** page of the review host (ADR 0006).

## Prerequisites

- Docker & Docker Compose (or standalone Caddy + PocketBase binaries)
- The site you want to review (dev server, staging URL, preview build, etc.)

---

## 1. Configure the upstream and the first owner

Navigate to `deploy/` and copy the example environment file:

```bash
cd deploy
cp .env.example .env
```

Edit `.env` to point `C11N_UPSTREAM` to your application:

```bash
# Example 1: Local dev server running on host
C11N_UPSTREAM=http://host.docker.internal:5173

# Example 2: Included Vue demo app
C11N_UPSTREAM=http://demo:5173

# Example 3: Remote staging environment
C11N_UPSTREAM=https://staging.example.com
```

Then set the identity values:

```bash
# The first owner. Its one-time sign-in link is printed to the PocketBase log.
C11N_OWNER_EMAIL=you@example.com

# The origin reviewers will use. Invite links are built from it.
C11N_PUBLIC_URL=http://localhost:8080
```

Leave `C11N_COOKIE_SECURE=true` unless the review host is plain http on a
host that is not `localhost`/`127.0.0.1` — browsers refuse to store a Secure
cookie there, and every sign-in would silently fail.

---

## 2. Start the services

```bash
docker compose up -d --build
```

Services will be available at:

- **Review host (proxy + overlay):** `http://localhost:8080`
- **PocketBase admin UI:** `http://localhost:8090/_/` (dev only, see step 6)

---

## 3. Sign in as the owner

There is no password and no sign-up form. On a fresh database the server
creates the owner account and writes a single-use sign-in link to its log:

```bash
docker compose logs pocketbase | grep "c11n bootstrap"
# c11n bootstrap: owner invite for you@example.com (single use, expires in 72h): http://localhost:8080/__c11n/auth/magic?t=...
```

Open that link. It signs you in, sets the session cookie and drops you on the
site with the `c11n` toolbar. The link works once; a second visit shows the
sign-in page and asks for a new link.

Treat the log line as a credential: it is the only copy of the token, and the
database stores just its hash.

---

## 4. Invite everyone else

Open the **sidebar** (≡ in the toolbar) and use the **Invite** section:
enter an email, pick a role, and copy the link it produces. Send it however you
normally talk to that person (Slack, email, …). There is no SMTP in the MVP.

Roles (ADR 0008):

| Inviter | May invite |
|---|---|
| `owner` | `team`, `client`, `owner` |
| `team` | `client` only |
| `client` | nobody |

The invitee opens the link, is signed in as themselves, and lands on the page
they were invited to. Links expire after `C11N_LINK_TTL_HOURS` (72 by default)
and are single use; a team or owner member can mint a fresh one for an existing
account at any time.

---

## 5. Reviewing the site

1. Open `http://localhost:8080`.
2. Click the **Comment Mode (crosshair)** icon in the toolbar.
3. Click any element on the page to pin a comment to it.
4. Open the **Sidebar** to see every comment grouped by route, reply in a
   thread, and resolve it.

When a session expires (14 days by default, `C11N_SESSION_TTL_DAYS`), any page
load shows the c11n sign-in page with "Your session has expired…". Ask the
project contact for a new link.

---

## 6. The PocketBase admin UI

The admin UI is deliberately **not** reachable through the review host:
`http://localhost:8080/__c11n/pb/_/` answers 404. Use it directly instead:

- **compose (dev):** `http://localhost:8090/_/`
- **Kubernetes:** port-forward it, e.g.
  `kubectl -n <ns> port-forward deploy/c11n 8090:8090`, then open
  `http://localhost:8090/_/`

It is a break-glass tool (superusers, backups), not part of the reviewer flow:
users are created by invites, and password auth on the `users` collection is
off.

---

## Running without Docker

The e2e suite runs the same stack from native binaries:

```bash
scripts/stack.sh up     # PocketBase :18090, demo :15173, Caddy :18080
# the bootstrap owner is owner@c11n.test; its link is in .stack/pocketbase.log
scripts/stack.sh down
```

`npm run e2e` does that, runs the whole Playwright suite against it, and tears
it down twice (once per upstream topology).
