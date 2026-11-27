// pb_hooks/bootstrap.pb.js
// Phase 3 task 3.2 — bootstrap the first owner (ADR 0006).
//
// A fresh deployment has no users: `users.createRule = null` closed public
// signup (migration 1764000000) and nobody can invite anybody until an owner
// exists. The chicken-and-egg is broken by the deployment itself: if there is
// no owner and C11N_OWNER_EMAIL is set, create that user with the owner role
// and mint one copy-link invite for it, then PRINT THE LINK TO THE LOG so the
// operator can read it with `kubectl logs` (or .stack/pocketbase.log locally).
//
// Why this is a router middleware and not a boot hook (all three verified on
// 0.39.11, two of them the hard way):
//
//  1. There is no JS `onServe`. plugins/jsvm/binds.go binds every app `On*`
//     hook EXCEPT OnServe ("excludeHooks := []string{\"OnServe\"}"), so a
//     literal `onServe(...)` throws `ReferenceError: onServe is not defined`
//     (PocketBase reports "failed to execute <file>" and serves without the
//     hook), and `$app.onServe().bindFunc(...)` silently never fires.
//  2. On a FRESH database `onBootstrap` runs BEFORE the pending migrations, so
//     `users.role` and the `invites` collection do not exist yet: the hook
//     fails with "no such column: role" and never retries.
//  3. Touching the database inside onBootstrap before `e.next()` is worse than
//     an error: it is a Go nil-pointer panic that kills the process.
//
// The first request after startup is the earliest point where the migrated
// schema is observable, and it is a point the deployment always reaches —
// `scripts/stack.sh` waits on /api/health, k8s runs its probes. So the work is
// done once, from a global middleware, guarded by a flag in the app store (the
// store lives on the Go app instance, so it is shared by every JS runtime in
// the hooks pool). The middleware always calls e.next(): it must never change
// the response of the request that happens to arrive first.
//
// The invite is a normal row in `invites`: single use, the same TTL as any
// other (C11N_LINK_TTL_HOURS, default 72) and the same verifier. The raw token
// exists only in this log line; the database stores its sha256.
//
// Same JSVM constraints as identity.pb.js: no cross-file (or even top-level)
// helpers inside a handler, so the mint is written out here again rather than
// shared with the invite route. Keep the two in step: alphabet, length, hash
// and expiry rules must stay identical, or a bootstrap link would not verify.
routerUse((e) => {
  try {
    if (!e.app.store().get("c11n_bootstrap_checked")) {
      // Set before the work so a failing bootstrap is not retried on every
      // request (the error is logged below). Concurrent first requests can
      // both pass this check; the owner insert is still guarded by the
      // count below and by the unique email on `users`.
      e.app.store().set("c11n_bootstrap_checked", true)

      const owners = e.app.countRecords("users", $dbx.hashExp({ role: "owner" }))
      if (owners === 0) {
        const email = ($os.getenv("C11N_OWNER_EMAIL") || "").trim().toLowerCase()
        if (!email) {
          e.app
            .logger()
            .info("c11n bootstrap: no owner user and C11N_OWNER_EMAIL is unset; set it to bootstrap the first owner")
        } else {
          // The validated TTL from identity.pb.js (loaded into the app store at
          // startup); 72 h only if that hook is somehow absent.
          let ttlHours = 72
          try {
            const configured = e.app.store().get("c11n_link_ttl_hours")
            if (typeof configured === "number") ttlHours = configured
          } catch (err) {
            ttlHours = 72
          }
          const publicUrl = ($os.getenv("C11N_PUBLIC_URL") || "").replace(/\/+$/, "")

          // Random, never-shared password: password auth still works until task
          // 3.9 disables it, and until then this account must not be
          // password-guessable. `setPassword` also sets passwordConfirm, so
          // validation passes.
          const password = $security.randomStringWithAlphabet(40, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")

          const users = e.app.findCollectionByNameOrId("users")
          const owner = new Record(users)
          owner.set("email", email)
          owner.set("name", email.split("@")[0])
          owner.set("role", "owner")
          owner.set("verified", true)
          owner.setPassword(password)
          e.app.save(owner)

          // 43 draws from a 64-symbol alphabet: 43 x 6 = 258 bits of entropy,
          // the same string a 32-byte base64url encoding produces.
          const token = $security.randomStringWithAlphabet(43, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
          const expiresAt = Date.now() + ttlHours * 3600 * 1000

          const invites = e.app.findCollectionByNameOrId("invites")
          const invite = new Record(invites)
          invite.set("email", email)
          invite.set("role", "owner")
          invite.set("user", owner.id)
          invite.set("tokenHash", $security.sha256(token))
          invite.set("expiresAt", new Date(expiresAt).toISOString())
          e.app.save(invite)

          const link = (publicUrl || "") + "/__c11n/auth/#t=" + token
          // STDOUT ONLY. `e.app.logger()` persists to PocketBase's `_logs`
          // table, so logging the link there would put a working single-use
          // token in a queryable database table (I3). console.log writes to the
          // process's stdout — `kubectl logs`, `docker logs`, the local
          // `.stack/pocketbase.log` — which is where an operator reads it and
          // what e2e/fixtures.ts parses. The logger line keeps the audit trail
          // (which invite was minted) without the secret.
          console.log("c11n bootstrap: owner invite for " + email + " (single use, expires in " + ttlHours + "h): " + link)
          e.app.logger().info("c11n bootstrap: owner invite minted", "email", email, "invite", invite.id)
        }
      }
    }
  } catch (err) {
    // Never fail the request that triggered this: a bootstrap failure is an
    // operator problem (bad env, DB locked) and must show up in the logs, not
    // as a broken health check.
    e.app.logger().error("c11n bootstrap: failed", "error", String(err))
    console.log("c11n bootstrap: failed: " + String(err))
  }
  return e.next()
})
