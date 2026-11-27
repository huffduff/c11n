#!/usr/bin/env node
// scripts/check-env-validation.mjs — the TTL env knobs are validated, not trusted.
//
// Why a script and not a Playwright spec: the e2e suite boots ONE stack with one
// environment (`scripts/stack.sh`), so a spec cannot make PocketBase start with
// `C11N_SESSION_TTL_DAYS=abc`. This boots two scratch PocketBases with the real
// hooks and migrations, one with garbage values and one with valid ones, and
// reads the effects off the wire.
//
// What it proves:
//   1. with C11N_SESSION_TTL_DAYS=abc and C11N_LINK_TTL_HOURS=9999 the server
//      falls back to 14 days / 72 hours (cookie Max-Age 1209600, JWT exp ~14d,
//      invite expiresAt ~72h) and prints a stdout warning for each bad knob;
//   2. with valid values (7 days / 5 hours) those values are honoured.
//
// Usage: node scripts/check-env-validation.mjs [--keep] [--port 28196]
//   POCKETBASE_BIN overrides the binary; otherwise .tools/pocketbase, else
//   `pocketbase` from PATH.
//
// State lives in .stack/env-check/ (gitignored) and is removed on success.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const portArg = argv.indexOf('--port')
const PORT = portArg === -1 ? Number(process.env.C11N_ENV_CHECK_PORT ?? 28196) : Number(argv[portArg + 1])
const BASE = `http://127.0.0.1:${PORT}`

const ADMIN = { email: 'env-check-admin@c11n.test', password: 'env-check-password' }
const SCRATCH = path.join(repoRoot, '.stack', 'env-check')

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

async function api(method, url, { token, data, headers } = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      ...(token ? { authorization: token } : {}),
      ...(data ? { 'content-type': 'application/json' } : {}),
      ...(headers ?? {}),
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
  return { status: res.status, json, text, headers: Object.fromEntries(res.headers.entries()) }
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

const nowSeconds = () => Math.floor(Date.now() / 1000)

/** Boot once with `env`, mint+claim an invite, return what the server decided. */
async function bootAndMeasure(label, env, dirs) {
  console.log(`\n${label}: ${JSON.stringify(env)}`)
  await run(resolvePocketbase(), ['superuser', 'upsert', ADMIN.email, ADMIN.password, ...dirs], {
    ...process.env,
    ...env,
  })

  const logPath = path.join(SCRATCH, 'pb.log')
  fs.writeFileSync(logPath, '')
  server = spawn(resolvePocketbase(), ['serve', `--http=127.0.0.1:${PORT}`, ...dirs], {
    stdio: ['ignore', fs.openSync(logPath, 'a'), fs.openSync(logPath, 'a')],
    env: { ...process.env, ...env },
  })
  await waitHealthy(30_000)

  const auth = await api('POST', '/api/collections/_superusers/auth-with-password', {
    data: { identity: ADMIN.email, password: ADMIN.password },
  })
  if (auth.status !== 200) throw new Error(`superuser auth -> ${auth.status} ${auth.text}`)
  const su = auth.json.token

  const email = `env-${Date.now()}@c11n.test`
  const invited = await api('POST', '/api/c11n/invite', { token: su, data: { email, role: 'client' } })
  if (invited.status !== 200) throw new Error(`invite -> ${invited.status} ${invited.text}`)
  const link = String(invited.json.link)
  const token = link.split('#t=')[1]
  if (!token) throw new Error(`invite link has no fragment token: ${link}`)

  const claimed = await api('POST', '/api/c11n/auth/claim', {
    headers: { origin: `http://127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin' },
    data: { t: token },
  })
  if (claimed.status !== 200) throw new Error(`claim -> ${claimed.status} ${claimed.text}`)

  const setCookie = claimed.headers['set-cookie'] ?? ''
  const maxAge = /max-age=(\d+)/i.exec(setCookie)
  const payload = JSON.parse(Buffer.from(setCookie.split('c11n_session=')[1].split('.')[1], 'base64url').toString())
  const inviteMs = new Date(invited.json.expiresAt).getTime() - Date.now()

  await stop()
  const stdout = fs.readFileSync(logPath, 'utf8')
  return {
    maxAge: maxAge ? Number(maxAge[1]) : null,
    jwtTtlSeconds: payload.exp - nowSeconds(),
    inviteHours: inviteMs / 3600_000,
    stdout,
  }
}

async function main() {
  fs.rmSync(SCRATCH, { recursive: true, force: true })
  fs.mkdirSync(path.join(SCRATCH, 'pb_data'), { recursive: true })
  fs.cpSync(path.join(repoRoot, 'deploy', 'pocketbase', 'pb_migrations'), path.join(SCRATCH, 'pb_migrations'), {
    recursive: true,
  })
  fs.cpSync(path.join(repoRoot, 'deploy', 'pocketbase', 'pb_hooks'), path.join(SCRATCH, 'pb_hooks'), {
    recursive: true,
  })
  const dirs = [
    '--dir', path.join(SCRATCH, 'pb_data'),
    '--migrationsDir', path.join(SCRATCH, 'pb_migrations'),
    '--hooksDir', path.join(SCRATCH, 'pb_hooks'),
  ]

  // 1. garbage in: the defaults, and a warning on stdout for each knob.
  const garbage = await bootAndMeasure(
    'garbage env',
    { C11N_SESSION_TTL_DAYS: 'abc', C11N_LINK_TTL_HOURS: '9999' },
    dirs,
  )
  check(garbage.maxAge === 1209600, `cookie Max-Age falls back to 14 days (got ${garbage.maxAge})`)
  check(
    Math.abs(garbage.jwtTtlSeconds - 14 * 86400) < 120,
    `token exp is ~14 days (got ${garbage.jwtTtlSeconds}s)`,
  )
  check(
    Math.abs(garbage.inviteHours - 72) < 0.5,
    `invite TTL falls back to 72h (got ${garbage.inviteHours}h)`,
  )
  check(garbage.stdout.includes('ignoring C11N_SESSION_TTL_DAYS=abc'), 'warns about the bad session TTL on stdout')
  check(garbage.stdout.includes('ignoring C11N_LINK_TTL_HOURS=9999'), 'warns about the bad link TTL on stdout')

  // 2. valid values in: honoured exactly.
  fs.rmSync(path.join(SCRATCH, 'pb_data'), { recursive: true, force: true })
  fs.mkdirSync(path.join(SCRATCH, 'pb_data'), { recursive: true })
  const valid = await bootAndMeasure(
    'valid env',
    { C11N_SESSION_TTL_DAYS: '7', C11N_LINK_TTL_HOURS: '5' },
    dirs,
  )
  check(valid.maxAge === 7 * 86400, `cookie Max-Age is 7 days (got ${valid.maxAge})`)
  check(Math.abs(valid.jwtTtlSeconds - 7 * 86400) < 120, `token exp is ~7 days (got ${valid.jwtTtlSeconds}s)`)
  check(Math.abs(valid.inviteHours - 5) < 0.5, `invite TTL is 5h (got ${valid.inviteHours}h)`)
  check(!valid.stdout.includes('ignoring C11N_SESSION_TTL_DAYS'), 'no warning for a valid session TTL')
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
console.log('\nenv validation holds')
