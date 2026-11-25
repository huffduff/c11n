/** Tear the stack down after the run, even if specs failed. */
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '..')

export default async function globalTeardown(): Promise<void> {
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
