#!/usr/bin/env node
// scripts/check-rule-floor.mjs — the rule, on its own, blocks non-authors.
//
// Why this is a script and not a Playwright spec: the point of the check is a
// PocketBase WITHOUT pb_hooks (the fallback if a deploy ships migrations but
// forgets the hooks dir). The e2e suite is built around one shared stack that
// always copies both dirs, runs once per fixture, and needs Chromium — none of
// that applies here. A script boots one scratch PocketBase on 28095, makes a
// handful of HTTP calls, and exits nonzero on a regression. It runs once per
// CI run in the e2e job, next to the pinned PocketBase it already fetched.
//
// What it proves:
//   1. the applied `comments.updateRule` carries the author/project/seq floor
//      (so a later migration cannot silently drop it);
//   2. with an empty hooks dir, a non-author PATCH {author: X} / {seq: n} /
//      {project: p} is rejected by the rule (404), i.e. the fields cannot be
//      written at all;
//   3. a non-author PATCH {resolved: true} still succeeds (200) — the rule is
//      not blanket-deny, so (2) means what it says.
//
// Usage: node scripts/check-rule-floor.mjs [--keep] [--port 28095]
//   POCKETBASE_BIN overrides the binary; otherwise .tools/pocketbase, else
//   `pocketbase` from PATH.
//
// State lives in .stack/rule-floor/ (gitignored) and is removed on success.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const portArg = argv.indexOf('--port')
const PORT = portArg === -1 ? Number(process.env.C11N_RULE_FLOOR_PORT ?? 28095) : Number(argv[portArg + 1])
const BASE = `http://127.0.0.1:${PORT}`

const ADMIN = { email: 'rule-floor-admin@c11n.test', password: 'rule-floor-password' }
const PASSWORD = 'password123456'
const SCRATCH = path.join(repoRoot, '.stack', 'rule-floor')

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
  return 'pocketbase' // PATH; the error below is clearer than a stat()
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} -> ${code}\n${out}`))))
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

async function main() {
  const pb = resolvePocketbase()

  // Fresh scratch state: migrations copied, hooks dir present but EMPTY.
  fs.rmSync(SCRATCH, { recursive: true, force: true })
  fs.mkdirSync(path.join(SCRATCH, 'pb_data'), { recursive: true })
  fs.mkdirSync(path.join(SCRATCH, 'pb_hooks'), { recursive: true })
  fs.cpSync(path.join(repoRoot, 'deploy', 'pocketbase', 'pb_migrations'), path.join(SCRATCH, 'pb_migrations'), {
    recursive: true,
  })

  const dirs = ['--dir', path.join(SCRATCH, 'pb_data'), '--migrationsDir', path.join(SCRATCH, 'pb_migrations'), '--hooksDir', path.join(SCRATCH, 'pb_hooks')]
  console.log(`booting ${pb} on :${PORT} with an empty hooks dir`)
  await run(pb, ['superuser', 'upsert', ADMIN.email, ADMIN.password, ...dirs])

  const logPath = path.join(SCRATCH, 'pb.log')
  server = spawn(pb, ['serve', `--http=127.0.0.1:${PORT}`, ...dirs], {
    stdio: ['ignore', fs.openSync(logPath, 'w'), fs.openSync(logPath, 'a')],
  })
  server.on('exit', (code) => {
    if (code !== null && code !== 0) console.log(`  note PocketBase exited with ${code} (see ${logPath})`)
  })
  await waitHealthy(30_000)

  // 1. the rule on the live collection carries the floor.
  const auth = await api('POST', '/api/collections/_superusers/auth-with-password', {
    data: { identity: ADMIN.email, password: ADMIN.password },
  })
  if (auth.status !== 200) throw new Error(`superuser auth -> ${auth.status} ${auth.text}`)
  const su = auth.json.token

  const collection = await api('GET', '/api/collections/comments', { token: su })
  const rule = String(collection.json?.updateRule ?? '')
  console.log('applied updateRule:', rule)
  for (const field of ['author', 'project', 'seq']) {
    check(rule.includes(`@request.body.${field}:isset = false`), `updateRule requires ${field} to be unset for non-authors`)
  }

  // 2. fixtures: two projects, two users, one comment (seq set by hand —
  //    without pb_hooks nothing assigns it).
  const projectRes = await api('GET', `/api/collections/projects/records?perPage=1&filter=${encodeURIComponent("slug='default'")}`, { token: su })
  const project = projectRes.json?.items?.[0]?.id
  if (!project) throw new Error('no seeded `default` project — did the migrations run?')
  const otherProject = (await api('POST', '/api/collections/projects/records', { token: su, data: { name: 'other', slug: `other-${Date.now()}` } })).json.id

  // `role` is required since the Phase 3 identity migration, and this script
  // runs with an EMPTY hooks dir on purpose — so the hook that defaults it is
  // not there and it has to be passed explicitly.
  const makeUser = async (name) =>
    (await api('POST', '/api/collections/users/records', {
      token: su,
      data: { email: `${name}-${Date.now()}@c11n.test`, password: PASSWORD, passwordConfirm: PASSWORD, name, role: 'client' },
    })).json
  const alice = await makeUser('alice')
  const bob = await makeUser('bob')

  const comment = (await api('POST', '/api/collections/comments/records', {
    token: su,
    data: { project, path: '/', selector: '#target', body: 'rule floor', author: alice.id, seq: 1 },
  })).json
  if (!comment?.id) throw new Error('could not seed the comment as superuser')

  // Password auth is off on `users` (ADR 0006, task 3.9), so a user bearer is
  // minted through the superuser impersonate endpoint.
  const bobAuth = await api('POST', `/api/collections/users/impersonate/${bob.id}`, {
    token: su,
    data: { duration: 3600 },
  })
  if (bobAuth.status !== 200) throw new Error(`bob auth -> ${bobAuth.status} ${bobAuth.text}`)
  const bobToken = bobAuth.json.token

  const patchUrl = `/api/collections/comments/records/${comment.id}`
  const attempts = [
    ['author', { author: bob.id }, 404],
    ['seq', { seq: 2 }, 404],
    ['project', { project: otherProject }, 404],
    // Control: the same caller, the same route, a field the rule allows.
    ['resolved', { resolved: true }, 200],
  ]
  for (const [field, data, expected] of attempts) {
    const res = await api('PATCH', patchUrl, { token: bobToken, data })
    check(res.status === expected, `non-author PATCH {${field}} -> ${res.status} (expected ${expected})`)
  }

  const after = await api('GET', patchUrl, { token: su })
  check(after.json?.author === alice.id, 'author is unchanged after the rejected PATCH')
  check(Number(after.json?.seq) === 1, `seq is unchanged after the rejected PATCH (got ${after.json?.seq})`)
  check(after.json?.project === project, 'project is unchanged after the rejected PATCH')
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
console.log('\nrule floor holds with no hooks dir')
