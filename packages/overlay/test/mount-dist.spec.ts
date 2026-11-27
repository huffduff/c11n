import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const bundlePath = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/overlay.js')
const inCi = !!process.env.CI

describe('built bundle (dist/overlay.js)', () => {
  // Requires `npm run build` first. Locally a missing dist stays a skip, so a
  // plain `npm test` works without a build. In CI it must FAIL instead: the
  // overlay job builds before testing on purpose, and a skip there would hide
  // exactly the regression this smoke test exists to catch (dist built but
  // broken, or the build step silently dropped from the workflow).
  it.skipIf(!existsSync(bundlePath) && !inCi)(
    'mounts the shadow-DOM host when executed in a document',
    () => {
      if (!existsSync(bundlePath)) {
        throw new Error(
          `dist/overlay.js is missing at ${bundlePath}: run 'npm run build -w packages/overlay' ` +
            'before testing. CI must not skip this test, because it is the only check that ' +
            'the built bundle actually mounts.',
        )
      }

      const code = readFileSync(bundlePath, 'utf8')
      expect(code).not.toMatch(/^\s*(import|export)\s/m)
      new Function(code)()

      const host = document.getElementById('c11n-root')
      expect(host).not.toBeNull()
      expect(host!.shadowRoot).not.toBeNull()
      expect(host!.shadowRoot!.querySelector('style')?.textContent).toContain('.c11n-toolbar')
      // The styles are there, the shell is empty: with no session (`me()`
      // answers 401 here — there is no proxy) the overlay renders nothing, so
      // there is no login form to fall back to either.
      expect(host!.shadowRoot!.querySelector('.c11n-toolbar')).toBeNull()
      expect(host!.shadowRoot!.querySelector('input')).toBeNull()
    },
  )
})
