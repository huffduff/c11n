import { defineConfig } from '@playwright/test'

/**
 * Full-stack e2e: real PocketBase, the demo-vue dev server and Caddy, all
 * started from `scripts/stack.sh` (native binaries, no Docker).
 *
 * One shared stack and one worker: PocketBase keeps a single SQLite file and
 * the specs assert on global row sets, so parallel workers would race each
 * other's fixtures.
 */
export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  // Whole-suite ceiling. `up` alone can take ~20 s on a cold cache; leave room
  // for the stack to boot plus every spec.
  globalTimeout: 5 * 60_000,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:18080',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 720 },
  },
})
