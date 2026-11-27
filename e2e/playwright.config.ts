import { defineConfig } from '@playwright/test'

/**
 * Full-stack e2e: real PocketBase, the demo app and Caddy, all started from
 * `scripts/stack.sh` (native binaries, no Docker).
 *
 * Two topologies, one suite. C11N_FIXTURE selects the upstream the proxy sits
 * in front of, and the specs that only make sense for one of them skip
 * themselves:
 *   vite  demo-vue served by the vite dev server on :15173 (HMR, today's dev)
 *   go    the built demo-vue served by examples/demo-go-server on :15174
 *         (the production topology from ADR 0001)
 *
 * The two runs are separate invocations (`npm run e2e:vite`, `npm run e2e:go`)
 * because each needs its own fresh stack: globalSetup wipes PocketBase's data
 * and brings the stack up for the fixture in the environment.
 *
 * One shared stack and one worker: PocketBase keeps a single SQLite file and
 * the specs assert on global row sets, so parallel workers would race each
 * other's fixtures.
 */
const fixture = process.env.C11N_FIXTURE ?? 'vite'

export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  // Whole-suite ceiling. `up` alone can take ~20 s on a cold cache (plus the
  // vite build for the go fixture); leave room for the stack to boot plus
  // every spec.
  globalTimeout: 5 * 60_000,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  // Name the run after its fixture: the reporter output of the two runs is
  // otherwise indistinguishable.
  projects: [{ name: fixture }],
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:18080',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 720 },
  },
})
