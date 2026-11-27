#!/usr/bin/env node
// scripts/check-migrations.mjs — the Phase 3 identity migration is reversible
// on a database that already has data.
//
// Why a script and not a Playwright spec: e2e always starts from an EMPTY
// pb_data (global-setup wipes it), so it can never exercise "up on a DB with
// rows in it", and it has no way to run `pocketbase migrate down`. This is the
// same reasoning as scripts/check-rule-floor.mjs: one scratch PocketBase on a
// scratch port, plain HTTP, no browser, exit 1 on a regression.
//
// What it proves, in order:
//   1. the schema BEFORE the identity pair accepts data (users, comments,
//      replies), then both migrations apply on top of that DB;
//   2. after `up`: `users.role` is a required select with the four ADR 0008
//      values, pre-existing users are backfilled to `team`, `invites` exists
//      with all five API rules null, `users.updateRule` carries the C1 floor and
//      `users.createRule` is still null;
//   3. `down 2` removes `invites`, the `role` field and the rule floor — with a
//      row in `invites` — and LEAVES THE DATA ALONE (user, comment and reply
//      rows survive);
//   4. `up` again reapplies cleanly (the backfill is idempotent) and the floor
//      is back.
//
// Usage: node scripts/check-migrations.mjs [--keep] [--port 28197]
//   POCKETBASE_BIN overrides the binary; otherwise .tools/pocketbase, else
//   `pocketbase` from PATH.
//
// State lives in .stack/migrations-check/ (gitignored), removed on success.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const portArg = argv.indexOf('--port')
const PORT = portArg === -1 ? Number(process.env.C11N_MIGRATIONS_PORT ?? 28197) : Number(argv[portArg + 1])
const BASE = `http://127.0.0.1:${PORT}`

// The migrations under test. Named explicitly on purpose: the check is about
// their reversibility, and a rename is a signal to update this file. They are
// applied in this order, and `down` has to revert exactly them.
const MIGRATION = '1764001000_roles_and_invites.js'
const FLOOR_MIGRATION = '1764001100_users_update_rule_floor.js'
const IDENTITY_MIGRATIONS = [MIGRATION, FLOOR_MIGRATION]
const ROLES = ['owner', 'team', 'client', 'agent']

const ADMIN = { email: 'migrations-admin@c11n.test', password: 'migrations-password' }
const PASSWORD = 'migrations-user-password'
const SCRATCH = path.join(repoRoot, '.stack', 'migrations-check')

const failures = []
function check(ok, what) {
  if (ok) {
    console.log(`  ok   ${what}`)
  } else {
    console.log(`  FAIL ${what}`)
    failures.push(what)
  }
}

function resolvePocketbase() {
  if (process.env.POCKETBASE_BIN) return process.env.POCKETBASE_BIN
  const local = path.join(repoRoot, '.tools', 'pocketbase')
  if (fs.existsSync(local)) return local
  return 'pocketbase'
}

function run(cmd, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} -> ${code}\n${out}`))))
    if (input) {
      // `migrate down` refuses to run without a "y" on stdin, and it exits 0
      // when cancelled — so a silent cancel would look like a successful down.
      child.stdin.end(input)
    }
  })
}

async function api(method, url, { token, data } = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      ...(token ? { authorization: token } : {}),
      ...(data ? { 'content-type': 'application/json' } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  })
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

async function start(pb, dirs) {
  const logPath = path.join(SCRATCH, 'pb.log')
  server = spawn(pb, ['serve', `--http=127.0.0.1:${PORT}`, ...dirs], {
    stdio: ['ignore', fs.openSync(logPath, 'w'), fs.openSync(logPath, 'a')],
  })
  server.on('exit', (code) => {
    if (code !== null && code !== 0) console.log(`  note PocketBase exited with ${code} (see ${logPath})`)
  })
  await waitHealthy(30_000)
}

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

async function superuserToken() {
  const auth = await api('POST', '/api/collections/_superusers/auth-with-password', {
    data: { identity: ADMIN.email, password: ADMIN.password },
  })
  if (auth.status !== 200) throw new Error(`superuser auth -> ${auth.status} ${auth.text}`)
  return auth.json.token
}

async function main() {
  const pb = resolvePocketbase()

  fs.rmSync(SCRATCH, { recursive: true, force: true })
  const dataDir = path.join(SCRATCH, 'pb_data')
  const hooksDir = path.join(SCRATCH, 'pb_hooks') // deliberately empty: migrations only
  const preDir = path.join(SCRATCH, 'migrations-pre')
  const fullDir = path.join(SCRATCH, 'migrations-full')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(hooksDir, { recursive: true })
  fs.mkdirSync(preDir, { recursive: true })

  const sourceDir = path.join(repoRoot, 'deploy', 'pocketbase', 'pb_migrations')
  const all = fs.readdirSync(sourceDir).filter((f) => f.endsWith('.js'))
  for (const migration of IDENTITY_MIGRATIONS) {
    if (!all.includes(migration)) throw new Error(`${migration} is missing from deploy/pocketbase/pb_migrations`)
  }
  // "pre" is every migration EXCEPT the identity pair, so the DB really starts
  // without `users.role`, without `invites` and without the users rule floor.
  for (const file of all) {
    if (IDENTITY_MIGRATIONS.includes(file)) continue
    fs.copyFileSync(path.join(sourceDir, file), path.join(preDir, file))
  }
  fs.cpSync(sourceDir, fullDir, { recursive: true })

  // ---- 1. the pre-identity schema, with data in it -----------------------
  console.log(`booting ${pb} on :${PORT} with the schema BEFORE ${MIGRATION}`)
  const preDirs = ['--dir', dataDir, '--migrationsDir', preDir, '--hooksDir', hooksDir]
  await run(pb, ['superuser', 'upsert', ADMIN.email, ADMIN.password, ...preDirs])
  await start(pb, preDirs)

  let su = await superuserToken()
  const projectRes = await api('GET', `/api/collections/projects/records?perPage=1&filter=${encodeURIComponent("slug='default'")}`, { token: su })
  const project = projectRes.json?.items?.[0]?.id
  if (!project) throw new Error('no seeded `default` project — did the pre-identity migrations run?')

  const user = (await api('POST', '/api/collections/users/records', {
    token: su,
    data: { email: `legacy-${Date.now()}@c11n.test`, password: PASSWORD, passwordConfirm: PASSWORD, name: 'Legacy' },
  })).json
  check(!!user?.id, 'a user can be created before the role field exists')
  check(user && !('role' in user), 'the pre-identity user has no role field')

  const comment = (await api('POST', '/api/collections/comments/records', {
    token: su,
    data: { project, path: '/', selector: '#legacy', body: 'before the identity migration', author: user.id, seq: 1 },
  })).json
  check(!!comment?.id, 'a comment can be created before the identity migration')
  const reply = (await api('POST', '/api/collections/replies/records', {
    token: su,
    data: { comment: comment.id, body: 'legacy reply', author: user.id },
  })).json
  check(!!reply?.id, 'a reply can be created before the identity migration')

  await stop()

  // ---- 2. up, on top of the data -----------------------------------------
  const fullDirs = ['--dir', dataDir, '--migrationsDir', fullDir, '--hooksDir', hooksDir]
  console.log(`\nmigrate up (applying ${MIGRATION} to a DB with data)`)
  await run(pb, ['migrate', 'up', ...fullDirs])
  await start(pb, fullDirs)
  su = await superuserToken()

  const usersCol = await api('GET', '/api/collections/users', { token: su })
  const roleField = usersCol.json?.fields?.find((f) => f.name === 'role')
  check(!!roleField, 'users.role exists after up')
  check(roleField?.type === 'select', `users.role is a select (got ${roleField?.type})`)
  check(roleField?.required === true, 'users.role is required')
  check(
    ROLES.every((r) => (roleField?.values ?? []).includes(r)) && (roleField?.values ?? []).length === ROLES.length,
    `users.role values are exactly ${ROLES.join('/')} (got ${(roleField?.values ?? []).join('/')})`,
  )

  const backfilled = await api('GET', `/api/collections/users/records/${user.id}`, { token: su })
  check(backfilled.json?.role === 'team', `the pre-existing user is backfilled to team (got ${backfilled.json?.role})`)

  const invitesCol = await api('GET', '/api/collections/invites', { token: su })
  check(invitesCol.status === 200, `invites collection exists (got ${invitesCol.status})`)
  for (const rule of ['listRule', 'viewRule', 'createRule', 'updateRule', 'deleteRule']) {
    check(invitesCol.json?.[rule] === null, `invites.${rule} is null (superuser/hooks only, got ${JSON.stringify(invitesCol.json?.[rule])})`)
  }
  const fieldNames = (invitesCol.json?.fields ?? []).map((f) => f.name)
  for (const name of ['email', 'role', 'invitedBy', 'user', 'tokenHash', 'expiresAt', 'usedAt']) {
    check(fieldNames.includes(name), `invites.${name} exists`)
  }
  const hashIndexes = (invitesCol.json?.indexes ?? []).join(' ')
  check(/UNIQUE INDEX idx_invites_token_hash ON invites \(tokenHash\)/.test(hashIndexes), 'invites.tokenHash has a unique index')

  // C1's rule floor rides on the same batch: `users` must not let an account
  // PATCH its own role/email/verified, and public signup must stay closed.
  const usersRule = String(usersCol.json?.updateRule ?? '')
  for (const field of ['role', 'email', 'verified']) {
    check(
      usersRule.includes(`@request.body.${field}:isset = false`),
      `users.updateRule requires ${field} to be unset for the account itself`,
    )
  }
  check(usersCol.json?.createRule === null, `users.createRule is null after all migrations (got ${JSON.stringify(usersCol.json?.createRule)})`)

  // A row in `invites` before the down: reverting a migration has to work on a
  // populated table, not just on an empty one.
  const inviteRow = await api('POST', '/api/collections/invites/records', {
    token: su,
    data: {
      email: `invited-${Date.now()}@c11n.test`,
      role: 'client',
      user: user.id,
      tokenHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  })
  check(inviteRow.status === 200, `an invite row can be created before down (got ${inviteRow.status})`)

  // A second user needs the defaulted role: the pre-identity rows are only the
  // migration's own backfill. This assertion is about the schema not blocking
  // an insert via the superuser API once a hook later supplies the value, so it
  // is checked with an explicit role here (the hook path is e2e's job).
  const withRole = await api('POST', '/api/collections/users/records', {
    token: su,
    data: { email: `new-${Date.now()}@c11n.test`, password: PASSWORD, passwordConfirm: PASSWORD, name: 'New', role: 'client' },
  })
  check(withRole.status === 200 && withRole.json?.role === 'client', `a user can be created with an explicit role (got ${withRole.status})`)
  const withoutRole = await api('POST', '/api/collections/users/records', {
    token: su,
    data: { email: `norole-${Date.now()}@c11n.test`, password: PASSWORD, passwordConfirm: PASSWORD, name: 'NoRole' },
  })
  check(withoutRole.status === 400, `a user without a role is rejected by the schema (got ${withoutRole.status})`)

  await stop()

  // ---- 3. down: gone, and the data is not --------------------------------
  // Two migrations now: the schema (role + invites) and the users rule floor.
  // `down N` reverts the last N applied, which is exactly this pair.
  console.log(`\nmigrate down ${IDENTITY_MIGRATIONS.length}`)
  await run(pb, ['migrate', 'down', String(IDENTITY_MIGRATIONS.length), ...fullDirs], { input: 'y\n' })
  // Serve against the PRE-identity migrations dir. `pocketbase serve` applies
  // every pending migration at startup regardless of --automigrate (that flag
  // only controls admin-UI schema snapshotting), so pointing it at fullDir here
  // silently re-applied the migration that was just reverted — the first
  // version of this check "verified" a down that never survived to be observed.
  const afterDownDirs = ['--dir', dataDir, '--migrationsDir', preDir, '--hooksDir', hooksDir]
  await start(pb, afterDownDirs)
  su = await superuserToken()

  const invitesAfter = await api('GET', '/api/collections/invites', { token: su })
  check(invitesAfter.status === 404, `invites is gone after down (got ${invitesAfter.status})`)
  const usersAfter = await api('GET', '/api/collections/users', { token: su })
  check(!(usersAfter.json?.fields ?? []).some((f) => f.name === 'role'), 'users.role is gone after down')
  // The floor is gone too: back to PocketBase's default, and signup still closed
  // (1764000000 is not part of this batch).
  check(
    String(usersAfter.json?.updateRule ?? '') === 'id = @request.auth.id',
    `users.updateRule is back to the default after down (got ${JSON.stringify(usersAfter.json?.updateRule)})`,
  )
  check(usersAfter.json?.createRule === null, 'users.createRule is still null after down (no public signup)')

  const userAfter = await api('GET', `/api/collections/users/records/${user.id}`, { token: su })
  check(userAfter.status === 200 && userAfter.json?.email === user.email, 'the legacy user row survives down')
  const commentAfter = await api('GET', `/api/collections/comments/records/${comment.id}`, { token: su })
  check(commentAfter.status === 200 && commentAfter.json?.body === 'before the identity migration', 'the legacy comment survives down')
  const replyAfter = await api('GET', `/api/collections/replies/records/${reply.id}`, { token: su })
  check(replyAfter.status === 200 && replyAfter.json?.body === 'legacy reply', 'the legacy reply survives down')

  await stop()

  // ---- 4. up again -------------------------------------------------------
  console.log(`\nmigrate up again (re-apply)`)
  await run(pb, ['migrate', 'up', ...fullDirs])
  await start(pb, fullDirs)
  su = await superuserToken()
  const reUsers = await api('GET', '/api/collections/users', { token: su })
  check((reUsers.json?.fields ?? []).some((f) => f.name === 'role'), 'users.role is back after re-up')
  const reBackfill = await api('GET', `/api/collections/users/records/${user.id}`, { token: su })
  check(reBackfill.json?.role === 'team', `the backfill is idempotent (got ${reBackfill.json?.role})`)
  const reInvites = await api('GET', '/api/collections/invites', { token: su })
  check(reInvites.status === 200, `invites is back after re-up (got ${reInvites.status})`)
  const reUsersRule = String(reUsers.json?.updateRule ?? '')
  check(
    reUsersRule.includes('@request.body.role:isset = false'),
    `the users rule floor is back after re-up (got ${JSON.stringify(reUsersRule)})`,
  )
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
  if (!keep) console.log(`scratch state kept at ${SCRATCH} for inspection`)
  process.exit(1)
}

if (!keep) fs.rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n${MIGRATION} applies, reverts and re-applies on a DB with data`)
