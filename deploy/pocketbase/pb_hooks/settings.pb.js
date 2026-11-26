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
// SECRETS: the access key and secret are never logged and never written to
// PocketBase's `_logs` table - only the bucket, endpoint, region, cron and
// keep count are. `$app.logger()` persists its arguments.
routerUse((e) => {
  try {
    if (!e.app.store().get("c11n_backup_settings_applied")) {
      e.app.store().set("c11n_backup_settings_applied", true)

      const cron = ($os.getenv("C11N_BACKUP_CRON") || "").trim()
      if (cron) {
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
          // tick and fill the logs. Say so once, loudly, and leave settings
          // alone.
          e.app.logger().error("c11n backups: C11N_BACKUP_CRON is set but C11N_BACKUP_S3_BUCKET is empty; scheduled backups are NOT enabled")
          console.log("c11n backups: C11N_BACKUP_CRON is set but C11N_BACKUP_S3_BUCKET is empty; scheduled backups are NOT enabled")
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
          e.app.save(settings)

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
  } catch (err) {
    // A failed backup configuration is an operator problem: log it, keep
    // serving, never fail the request that triggered the attempt.
    e.app.logger().error("c11n backups: failed to apply settings", "error", String(err))
    console.log("c11n backups: failed to apply settings: " + String(err))
  }
  return e.next()
})
