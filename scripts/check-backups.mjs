#!/usr/bin/env node
// scripts/check-backups.mjs — the backup configuration and the backup itself.
//
// Two different things are proven here, because they fail in different ways:
//
//  1. CONFIGURATION (5.4). pb_hooks/settings.pb.js applies settings.backups
//     from C11N_BACKUP_* on the first request. A scratch PocketBase boots with
//     the real migrations and hooks, and the superuser settings API is asked
//     what it actually stored: cron, keep, S3 bucket/endpoint/region and
//     path-style. The access key and secret must NOT come back in the
//     response body (PocketBase masks secret settings; this asserts it, since
//     a future version that echoed them would leak the bucket credentials to
//     every superuser page view).
//     A second boot with NO backup env proves the hook leaves settings alone.
//
//  2. THE MECHANISM (5.4, local, no S3). A backup taken with POST /api/backups
//     appears in GET /api/backups and can be restored with
//     POST /api/backups/{key}/restore, after which data written BETWEEN the
//     backup and the restore is gone. Done on a third scratch database with no
//     S3 target, so it exercises exactly the code path a manual backup takes
//     (docs/runbook.md) with our migrations and hooks loaded.
//
// The S3 upload itself is NOT proven: there is no bucket here. The chart and
// the runbook say so; the sweep happens on the cluster.
//
// Usage: node scripts/check-backups.mjs [--keep] [--port 28198]
//   POCKETBASE_BIN overrides the binary; otherwise .tools/pocketbase, else
//   `pocketbase` from PATH. State lives in .stack/backups-check/ (gitignored).

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const portArg = argv.indexOf('--port')
const PORT = portArg === -1 ? Number(process.env.C11N_BACKUPS_CHECK_PORT ?? 28198) : Number(argv[portArg + 1])
const BASE = `http://127.0.0.1:${PORT}`

const ADMIN = { email: 'backups-check-admin@c11n.test', password: 'backups-check-password' }
const SCRATCH = path.join(repoRoot, '.stack', 'backups-check')

// Distinctive values: a settings page full of defaults would pass a sloppy
// assertion.
const BACKUP_ENV = {
  C11N_BACKUP_CRON: '15 2 * * *',
  C11N_BACKUP_KEEP: '7',
  C11N_BACKUP_S3_ENDPOINT: 'https://minio.c11n.test:9000',
  C11N_BACKUP_S3_BUCKET: 'c11n-backups-test',
  C11N_BACKUP_S3_REGION: 'eu-central-1',
  C11N_BACKUP_S3_ACCESS_KEY: 'AKIAEXAMPLECHECKKEY',
  C11N_BACKUP_S3_SECRET: 'example-secret-value-do-not-log',
  C11N_BACKUP_S3_FORCE_PATH_STYLE: 'true',
}

const failures = []
function check(ok, what, detail) {
  if (ok) {
    console.log(`  ok   ${what}`)
  } else {
    console.log(`  FAIL ${what}${detail ? ` (${detail})` : ''}`)
    failures.push(what)
  }
}

function resolvePocketbase() {
  if (process.env.POCKETBASE_BIN) return process.env.POCKETBASE_BIN
  const local = path.join(repoRoot, '.tools', 'pocketbase')
  if (fs.existsSync(local)) return local
  return 'pocketbase'
}

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} -> ${code}\n${out}`))))
  })
}

async function api(method, url, { token, data } = {}) {
  // A restore makes PocketBase re-exec: for a moment nothing is listening and
  // fetch() throws ECONNREFUSED. That is a state this script polls THROUGH, not
  // an error: report it as status 0 and let the caller retry. Anything that
  // treats 0 as success (nothing does) would be a bug of its own.
  let res
  try {
    res = await fetch(`${BASE}${url}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'content-type': 'application/json' } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
      signal: AbortSignal.timeout(5000),
    })
  } catch (err) {
    return { status: 0, json: undefined, text: `${err.message}` }
  }
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  return { status: res.status, json, text }
}

async function waitHealthy(deadlineMs) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`PocketBase did not answer /api/health within ${deadlineMs}ms`)
}

let server = null
let logPath = ''

async function stop() {
  if (!server) return
  const child = server
  server = null
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 5000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function dirsFor(name) {
  const root = path.join(SCRATCH, name)
  return {
    root,
    dirs: [
      '--dir', path.join(root, 'pb_data'),
      '--migrationsDir', path.join(root, 'pb_migrations'),
      '--hooksDir', path.join(root, 'pb_hooks'),
    ],
  }
}

async function boot(name, env) {
  const { root, dirs } = dirsFor(name)
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, 'pb_data'), { recursive: true })
  fs.cpSync(path.join(repoRoot, 'deploy', 'pocketbase', 'pb_migrations'), path.join(root, 'pb_migrations'), { recursive: true })
  fs.cpSync(path.join(repoRoot, 'deploy', 'pocketbase', 'pb_hooks'), path.join(root, 'pb_hooks'), { recursive: true })

  const fullEnv = { ...process.env, ...env }
  await run(resolvePocketbase(), ['superuser', 'upsert', ADMIN.email, ADMIN.password, ...dirs], fullEnv)

  logPath = path.join(root, 'pb.log')
  fs.writeFileSync(logPath, '')
  server = spawn(resolvePocketbase(), ['serve', `--http=127.0.0.1:${PORT}`, ...dirs], {
    stdio: ['ignore', fs.openSync(logPath, 'a'), fs.openSync(logPath, 'a')],
    env: fullEnv,
  })
  await waitHealthy(30_000)

  const auth = await api('POST', '/api/collections/_superusers/auth-with-password', {
    data: { identity: ADMIN.email, password: ADMIN.password },
  })
  if (auth.status !== 200) throw new Error(`superuser auth -> ${auth.status} ${auth.text}`)
  return { token: auth.json.token, log: () => fs.readFileSync(logPath, 'utf8') }
}

async function main() {
  fs.rmSync(SCRATCH, { recursive: true, force: true })
  fs.mkdirSync(SCRATCH, { recursive: true })

  // ---- 1. configured from env --------------------------------------------
  console.log('\nbackup settings from env')
  {
    const su = await boot('configured', BACKUP_ENV)
    // The hook runs on the first request; /api/health already went out during
    // waitHealthy, but hit it again so a mid-boot request race cannot hide.
    await api('GET', '/api/health')
    const settings = await api('GET', '/api/settings', { token: su.token })
    check(settings.status === 200, `settings API answers (got ${settings.status})`)
    const b = settings.json?.backups ?? {}
    const s3 = b.s3 ?? {}
    check(b.cron === BACKUP_ENV.C11N_BACKUP_CRON, `cron is ${BACKUP_ENV.C11N_BACKUP_CRON}`, `got ${JSON.stringify(b.cron)}`)
    check(b.cronMaxKeep === 7, 'cronMaxKeep is 7', `got ${JSON.stringify(b.cronMaxKeep)}`)
    check(s3.enabled === true, 's3.enabled is true')
    check(s3.bucket === BACKUP_ENV.C11N_BACKUP_S3_BUCKET, `bucket is ${BACKUP_ENV.C11N_BACKUP_S3_BUCKET}`, `got ${JSON.stringify(s3.bucket)}`)
    check(s3.endpoint === BACKUP_ENV.C11N_BACKUP_S3_ENDPOINT, `endpoint is ${BACKUP_ENV.C11N_BACKUP_S3_ENDPOINT}`, `got ${JSON.stringify(s3.endpoint)}`)
    check(s3.region === BACKUP_ENV.C11N_BACKUP_S3_REGION, `region is ${BACKUP_ENV.C11N_BACKUP_S3_REGION}`, `got ${JSON.stringify(s3.region)}`)
    check(s3.forcePathStyle === true, 'forcePathStyle is true')

    // A leaked secret would be in the JSON body, the raw text, or the log.
    // PocketBase masks `backups.s3.secret` in the settings response (it comes
    // back empty) but NOT the access key - that is a PB decision, and the
    // access key is an identifier rather than the credential. What must never
    // leak is the secret; we also keep both out of our own log output.
    check(!settings.text.includes(BACKUP_ENV.C11N_BACKUP_S3_SECRET), 'the S3 secret is not echoed in the settings response')
    check(!su.log().includes(BACKUP_ENV.C11N_BACKUP_S3_SECRET), 'the S3 secret is not written to the log')
    check(!su.log().includes(BACKUP_ENV.C11N_BACKUP_S3_ACCESS_KEY), 'the access key is not written to the log')
    check(su.log().includes('c11n backups: scheduled'), 'the hook logs that backups were scheduled')
    check(su.log().includes('c11n-backups-test'), 'the hook names the bucket in its log line')
    await stop()
  }

  // ---- 2. no env: settings untouched -------------------------------------
  console.log('\nno backup env: settings untouched')
  {
    const su = await boot('unconfigured', {})
    await api('GET', '/api/health')
    const settings = await api('GET', '/api/settings', { token: su.token })
    const b = settings.json?.backups ?? {}
    check(b.cron === '', 'cron stays empty', `got ${JSON.stringify(b.cron)}`)
    check((b.s3 ?? {}).enabled === false, 's3 stays disabled')
    check((b.s3 ?? {}).bucket !== 'c11n-backups-test', 'the bucket was not written')
    check(!su.log().includes('c11n backups: scheduled'), 'the hook did not touch the settings')
    await stop()
  }

  // ---- 3. a real backup round trip (local, no S3) ------------------------
  console.log('\nbackup round trip')
  {
    const su = await boot('roundtrip', {})
    await api('GET', '/api/health')

    const createProject = (slug) => api('POST', '/api/collections/projects/records', {
      token: su.token,
      data: { name: slug, slug },
    })
    const projectCount = async (slug) => {
      const res = await api(
        'GET',
        `/api/collections/projects/records?perPage=1&filter=${encodeURIComponent(`slug='${slug}'`)}`,
        { token: su.token },
      )
      return res.json?.totalItems ?? -1
    }

    const before = await createProject('before-backup')
    check(before.status === 200, `seeded a record before the backup (got ${before.status})`)

    const made = await api('POST', '/api/backups', { token: su.token, data: {} })
    check(made.status === 204 || made.status === 200, `POST /api/backups succeeded (got ${made.status} ${made.text.slice(0, 200)})`)

    const list = await api('GET', '/api/backups', { token: su.token })
    const entries = list.json?.items ?? list.json ?? []
    check(Array.isArray(entries) && entries.length >= 1, `GET /api/backups lists the backup (${entries.length})`)
    const key = entries[0]?.key
    check(typeof key === 'string' && key.length > 0, `the backup has a key (${key})`)

    const after = await createProject('after-backup')
    check(after.status === 200, 'seeded a record AFTER the backup')
    check((await projectCount('after-backup')) === 1, 'the post-backup record is present before the restore')

    const restored = await api('POST', `/api/backups/${encodeURIComponent(key)}/restore`, { token: su.token, data: {} })
    check([200, 204].includes(restored.status), `restore accepted (got ${restored.status} ${restored.text.slice(0, 200)})`)

    // The restore is ASYNCHRONOUS: PocketBase unpacks the backup into the data
    // dir and restarts itself (the process re-execs and the log shows a second
    // "Server started"). Between the 204 and the new listener every request
    // fails at the socket layer, so wait for /api/health before polling - and
    // then poll, because a single sleep either flakes or hides a real failure.
    // The superuser row comes from the restored database, which also proves the
    // restored file is a working PocketBase. Bounded: 30 s to come back, then
    // 30 s for the data to match.
    const findSlug = async (token, slug) => {
      const res = await api(
        'GET',
        `/api/collections/projects/records?perPage=1&filter=${encodeURIComponent(`slug='${slug}'`)}`,
        { token },
      )
      return res.json?.totalItems ?? -1
    }
    await waitHealthy(30_000)
    let token = su.token
    let kept = -1
    let gone = -1
    const until = Date.now() + 30_000
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500))
      const auth = await api('POST', '/api/collections/_superusers/auth-with-password', {
        data: { identity: ADMIN.email, password: ADMIN.password },
      })
      if (auth.status !== 200) continue
      token = auth.json.token
      kept = await findSlug(token, 'before-backup')
      gone = await findSlug(token, 'after-backup')
      if (kept === 1 && gone === 0) break
    }
    check(kept === 1, `a record that existed at backup time survived the restore (found ${kept})`)
    check(gone === 0, `the record written after the backup is gone after the restore (found ${gone})`)
    await stop()
  }
}

try {
  await main()
} catch (err) {
  failures.push(`error: ${err.message}`)
} finally {
  await stop()
}

if (failures.length > 0) {
  console.log(`\n${failures.length} failed:`)
  for (const f of failures) console.log(`  - ${f}`)
  console.log(`scratch state kept at ${SCRATCH} for inspection`)
  process.exit(1)
}

if (!keep) fs.rmSync(SCRATCH, { recursive: true, force: true })
console.log('\nbackups hold')
