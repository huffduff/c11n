import { defineConfig } from '@playwright/test'

/**
 * Full-stack e2e: real PocketBase, the demo app and Caddy, all started from
 * `scripts/stack.sh` (native binaries, no Docker).
 *
 * Two topologies, one suite. C11N_FIXTURE selects the upstream the proxy sits
 * in front of:
 *   vite   demo-vue served by the vite dev server on :15173 (HMR, today's dev)
 *   go     the built demo-vue served by examples/demo-go-server on :15174
 *          (the production topology from ADR 0001)
 *   sasser the real dogfood app — sasser-studios frontend/ via vite dev on
 *          :15175, HTTPS (ADR 0009). Only specs/upstream-compat.spec.ts runs;
 *          the demo specs assert on demo-vue's DOM.
 *
 * Selection is done here, not with test.skip, for the sasser run: the demo
 * specs fail on their first locator against a different app, and rewriting a
 * dozen files to skip themselves would be worse than one testMatch. The reverse
 * direction is a describe-level skip inside upstream-compat.spec.ts, matching
 * topology.spec.ts's existing pattern.
 *
 * Each run is a separate invocation (`npm run e2e:vite`, `e2e:go`, `e2e:sasser`)
 * because each needs its own fresh stack: globalSetup wipes PocketBase's data
 * and brings the stack up for the fixture in the environment.
 *
 * One shared stack and one worker: PocketBase keeps a single SQLite file and
 * the specs assert on global row sets, so parallel workers would race each
 * other's fixtures.
 */
const fixture = process.env.C11N_FIXTURE ?? (process.env.C11N_E2E_EXTERNAL === '1' ? 'go' : 'vite')

// The sasser run is the compatibility probe against the real client app: the
// demo-only specs are not selected at all (see above).
// Patterns are matched against the file path relative to testDir, so the
// directory itself must not be repeated here.
const testMatch = fixture === 'sasser' ? ['upstream-compat.spec.ts'] : ['**/*.spec.ts']

// In external mode the origin is whatever the operator points at (normally a
// port-forward of the cluster's Service). The default is the native stack.
const baseURL = (process.env.C11N_E2E_BASE_URL ?? 'http://127.0.0.1:18080').replace(/\/+$/, '')

export default defineConfig({
  testDir: './specs',
  testMatch,
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
    baseURL,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 720 },
  },
})
