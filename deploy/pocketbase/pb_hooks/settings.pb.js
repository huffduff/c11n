// pb_hooks/settings.pb.js
// Phase 5 task 5.4 - scheduled S3 backups, configured from the environment.
//
// PocketBase has backup machinery built in: `settings.backups` holds a cron
// expression, a retention count and an S3 target, and the server uploads a zip
// of the data directory on that schedule (pruning to the keep count). The
// endpoint is `POST /api/backups` and the restore is the admin UI or
// `POST /api/backups/{key}/restore` (docs/runbook.md).
//
// The VALUES for those settings are chart values, so they arrive as env:
//
//   C11N_BACKUP_CRON            5-field cron; EMPTY = off (the default)
//   C11N_BACKUP_KEEP            backups to keep (default 14, clamped 1..365)
//   C11N_BACKUP_S3_ENDPOINT     e.g. https://s3.eu-central-1.amazonaws.com
//   C11N_BACKUP_S3_BUCKET       required for backups to be enabled
//   C11N_BACKUP_S3_REGION
//   C11N_BACKUP_S3_ACCESS_KEY
//   C11N_BACKUP_S3_SECRET
//   C11N_BACKUP_S3_FORCE_PATH_STYLE  "true"/"1" for MinIO and most non-AWS S3
//
// When C11N_BACKUP_CRON is empty the settings are NOT touched at all: an
// operator who configured backups in the admin UI keeps that configuration,
// and a chart with no backup values produces no surprise uploads.
//
// CONSEQUENCE, and it is stated the same way in values.yaml and the runbook:
// with backup values set, this hook is the source of truth and re-applies them
// on every process start. A backup setting changed in the admin UI is REVERTED
// by the next pod restart.
//
// Why this shape (same constraints as bootstrap.pb.js, all verified on
// 0.39.11):
//
//   * There is no JS `onServe` hook, so a boot-time hook is not available.
//   * On a fresh database `onBootstrap` runs BEFORE the migrations, and
//     touching the DB there panics the process.
//   * The first HTTP request is the earliest point where the migrated schema
//     is observable, and the chart's readiness probe guarantees one.
//
// So: a global router middleware, guarded by a flag in the app store (shared
// by every JS runtime in the hooks pool), which always calls e.next() and
// never changes the response of the request that happens to arrive first.
//
// RETRY: the done flag is set only AFTER `e.app.save()` succeeds, so a failed
// save (disk full, validation, a PocketBase upgrade that moved a field) is
// retried on a later request instead of leaving backups silently off. The retry
// is rate-limited to one attempt per RETRY_AFTER_MS via a timestamp in the same
// store, so a permanently failing save logs once a minute rather than on every
// request.
//
// SECRETS: the access key and secret are never logged and never written to
// PocketBase's `_logs` table - only the bucket, endpoint, region, cron and
// keep count are. `$app.logger()` persists its arguments.

// NOTE: no top-level constants. PocketBase runs each hook handler in its own
// JS runtime, so a `const` declared at file scope is NOT visible inside the
// routerUse callback (ReferenceError at request time - observed on 0.39.11).
routerUse((e) => {
  // One attempt per minute while a save is failing.
  const retryAfterMs = 60 * 1000
  try {
    const store = e.app.store()
    if (!store.get("c11n_backup_settings_done")) {
      const now = Date.now()
      const lastAttempt = Number(store.get("c11n_backup_settings_attempt") || 0)
      if (now - lastAttempt >= retryAfterMs) {
        // Record the attempt BEFORE the work: a save that throws must not be
        // retried on every request, and this timestamp is what bounds it.
        store.set("c11n_backup_settings_attempt", now)

        const cron = ($os.getenv("C11N_BACKUP_CRON") || "").trim()
        if (!cron) {
          // Nothing to apply, and static env will not change this process.
          store.set("c11n_backup_settings_done", true)
        } else {
          const bucket = ($os.getenv("C11N_BACKUP_S3_BUCKET") || "").trim()
          const endpoint = ($os.getenv("C11N_BACKUP_S3_ENDPOINT") || "").trim()
          const region = ($os.getenv("C11N_BACKUP_S3_REGION") || "").trim()
          const accessKey = ($os.getenv("C11N_BACKUP_S3_ACCESS_KEY") || "").trim()
          const secret = ($os.getenv("C11N_BACKUP_S3_SECRET") || "").trim()
          const forcePathStyleRaw = ($os.getenv("C11N_BACKUP_S3_FORCE_PATH_STYLE") || "").trim().toLowerCase()
          const forcePathStyle = forcePathStyleRaw === "true" || forcePathStyleRaw === "1"

          // Parse defensively: a bad value must not stop the server, and the
          // default that was validated in the chart is the right fallback.
          let keep = 14
          const rawKeep = ($os.getenv("C11N_BACKUP_KEEP") || "").trim()
          if (rawKeep) {
            const parsed = parseInt(rawKeep, 10)
            if (isNaN(parsed) || parsed < 1 || parsed > 365) {
              console.log("c11n backups: ignoring C11N_BACKUP_KEEP=" + rawKeep + " (expected 1..365); using " + keep)
            } else {
              keep = parsed
            }
          }

          if (!bucket) {
            // Scheduled backups with nowhere to put them would fail on every
            // tick and fill the logs. Say so ONCE (the chart refuses this
            // combination at render time) and leave the settings alone.
            e.app.logger().error("c11n backups: C11N_BACKUP_CRON is set but C11N_BACKUP_S3_BUCKET is empty; scheduled backups are NOT enabled")
            console.log("c11n backups: C11N_BACKUP_CRON is set but C11N_BACKUP_S3_BUCKET is empty; scheduled backups are NOT enabled")
            store.set("c11n_backup_settings_done", true)
          } else {
            const settings = e.app.settings()
            settings.backups.cron = cron
            settings.backups.cronMaxKeep = keep
            settings.backups.s3.enabled = true
            settings.backups.s3.bucket = bucket
            settings.backups.s3.region = region
            settings.backups.s3.endpoint = endpoint
            settings.backups.s3.accessKey = accessKey
            settings.backups.s3.secret = secret
            settings.backups.s3.forcePathStyle = forcePathStyle
            // Throws on failure: the catch below logs it, the done flag stays
            // unset, and the next attempt is at least RETRY_AFTER_MS away.
            e.app.save(settings)

            // Only now - after the save - and these lines describe a save that
            // actually happened.
            store.set("c11n_backup_settings_done", true)

            // No credentials here on purpose (see the header).
            console.log(
              "c11n backups: scheduled '" + cron + "' to s3 bucket " + bucket +
                (endpoint ? " at " + endpoint : "") + " keeping " + keep,
            )
            e.app.logger().info(
              "c11n backups: settings applied",
              "cron", cron,
              "keep", String(keep),
              "bucket", bucket,
              "endpoint", endpoint,
              "forcePathStyle", String(forcePathStyle),
            )
          }
        }
      }
    }
  } catch (err) {
    // A failed backup configuration is an operator problem: log it, keep
    // serving, never fail the request that triggered the attempt. The done flag
    // is still unset, so a later request retries (rate-limited above).
    e.app.logger().error("c11n backups: failed to apply settings", "error", String(err))
    console.log("c11n backups: failed to apply settings: " + String(err))
  }
  return e.next()
})
