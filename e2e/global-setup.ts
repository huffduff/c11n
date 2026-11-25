/**
 * Stack bootstrap for the e2e run: wipe PocketBase's data directory so every
 * suite starts from the seeded schema (one `default` project, no comments),
 * then bring the stack up via the same script a developer uses.
 *
 * Any pre-existing stack (from a crashed run) is torn down first: `up` refuses
 * to start twice, and a leftover process would hold the fixed ports.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '..')
const stackScript = path.join(repoRoot, 'scripts', 'stack.sh')
const stateDir = process.env.C11N_STACK_DIR ?? path.join(repoRoot, '.stack')

function stack(action: 'up' | 'down') {
  execFileSync('bash', [stackScript, action], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  })
}

export default async function globalSetup(): Promise<void> {
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
