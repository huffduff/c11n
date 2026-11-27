/**
 * Tear the stack down after the run, even if specs failed.
 *
 * In external mode there is no local stack: the deployment under test is not
 * ours to stop, so this does nothing (the operator's port-forwards live in
 * their own shell).
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '..')

export default async function globalTeardown(): Promise<void> {
  if (process.env.C11N_E2E_EXTERNAL === '1') return
  try {
    execFileSync('bash', [path.join(repoRoot, 'scripts', 'stack.sh'), 'down'], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    })
  } catch (err) {
    // Never mask a failing suite with a teardown error; the next run's setup
    // tears down anything left behind anyway.
    console.warn(`stack teardown failed: ${(err as Error).message}`)
  }
}
