/**
 * Stack bootstrap for the e2e run: wipe PocketBase's data directory so every
 * suite starts from the seeded schema (one `default` project, no comments),
 * then bring the stack up via the same script a developer uses.
 *
 * Any pre-existing stack (from a crashed run) is torn down first: `up` refuses
 * to start twice, and a leftover process would hold the fixed ports.
 *
 * EXTERNAL MODE (C11N_E2E_EXTERNAL=1) does none of that: the deployment under
 * test belongs to somebody else (a real cluster), so there is nothing to wipe
 * and nothing to start. It only checks that the environment is complete and
 * that both endpoints answer, so a typo'd URL fails here with one clear
 * message instead of as forty confusing spec failures.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { destructiveRefusal } from './external-guard'

const repoRoot = path.resolve(__dirname, '..')
const stackScript = path.join(repoRoot, 'scripts', 'stack.sh')
const stateDir = process.env.C11N_STACK_DIR ?? path.join(repoRoot, '.stack')

const EXTERNAL = process.env.C11N_E2E_EXTERNAL === '1'

function stack(action: 'up' | 'down') {
  execFileSync('bash', [stackScript, action], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  })
}

/** Any HTTP answer below 500 proves something speaks HTTP at `url`. */
async function probe(url: string, what: string): Promise<void> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`)
  } catch (err) {
    throw new Error(`${what} is not reachable at ${url}: ${(err as Error).message}`)
  }
}

export default async function globalSetup(): Promise<void> {
  if (EXTERNAL) {
    const required = ['C11N_E2E_BASE_URL', 'C11N_E2E_PB_URL', 'C11N_E2E_SU_EMAIL', 'C11N_E2E_SU_PASSWORD']
    const missing = required.filter((name) => !process.env[name])
    if (missing.length > 0) {
      throw new Error(
        `C11N_E2E_EXTERNAL=1 but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} unset. ` +
          'See scripts/cluster/e2e-against-ingress.md.',
      )
    }
    const baseUrl = process.env.C11N_E2E_BASE_URL!.replace(/\/+$/, '')
    const pbUrl = process.env.C11N_E2E_PB_URL!.replace(/\/+$/, '')
    // Before probing anything: is this deployment allowed to be wiped? The
    // suite deletes every comment and reply (resetData), so a real review site
    // must be refused here, once, with the reason - not half way through a run.
    const refusal = destructiveRefusal()
    if (refusal) throw new Error(refusal)
    // The sign-in page is the one ungated route, so this is a real answer and
    // not a 401 from the gate.
    await probe(`${baseUrl}/__c11n/auth/`, 'the proxy')
    await probe(`${pbUrl}/api/health`, 'PocketBase')
    console.log(`external mode: ${baseUrl} (PocketBase ${pbUrl}); no local stack is started or wiped`)
    return
  }

  // A crashed run leaves pidfiles and live processes behind; `down` is
  // idempotent and only stops what our pidfiles point at.
  try {
    stack('down')
  } catch {
    // Nothing was running.
  }

  fs.rmSync(path.join(stateDir, 'pb_data'), { recursive: true, force: true })

  try {
    stack('up')
  } catch (err) {
    throw new Error(
      `scripts/stack.sh up failed — the e2e suite cannot run. ` +
        `Check that CADDY_BIN/POCKETBASE_BIN are set and packages/overlay/dist/overlay.js is built. ` +
        `Cause: ${(err as Error).message}`,
    )
  }

  const creds = path.join(stateDir, 'creds.json')
  if (!fs.existsSync(creds)) {
    throw new Error(`scripts/stack.sh up reported success but wrote no ${creds}`)
  }
}
