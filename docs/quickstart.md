# Quickstart

Get `c11n` running in front of your web application for stakeholder review.

## Prerequisites

- Docker & Docker Compose (or standalone Caddy + PocketBase binaries)
- The site you want to review (dev server, staging URL, preview build, etc.)

---

## 1. Configure the upstream

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

---

## 2. Start the services

Start the Caddy reverse proxy and PocketBase backend:

```bash
docker compose up -d --build
```

Services will be available at:
- **Proxy (Review Site with Overlay):** `http://localhost:8080`
- **PocketBase Admin UI:** `http://localhost:8090/_/`

---

## 3. Initial PocketBase setup

1. Open `http://localhost:8090/_/` in your browser.
2. Create your initial admin account on first launch.
3. Verify collections:
   - `projects` (with default project created by migration)
   - `comments`
   - `replies`
   - `users`
4. Under **Users**, create accounts for team members and stakeholders who will leave comments.

---

## 4. Reviewing the site

1. Open `http://localhost:8080` in your browser.
2. Notice the `c11n` toolbar floating at the bottom center.
3. Click **Sign in** to log in with a user account created in step 3.
4. Click the **Comment Mode (crosshair)** icon in the toolbar.
5. Click any DOM element on the page to leave a comment pinned directly to that element.
6. Open the **Sidebar** to view all project comments grouped by route/path and toggle resolved status.
