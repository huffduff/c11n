import { expect, test } from '@playwright/test'
import { magicLinkFor, readCreds } from '../fixtures'

/**
 * I2 (security review) — `next` must never leave the proxy's origin.
 *
 * The old validator only looked for `//`, a backslash and `://`. A value like
 * `/%09//evil` passed it: the hook 302s to a Location containing a literal TAB,
 * Chromium strips tabs while parsing a URL, and the browser lands on `//evil`
 * (proven in Chromium, not assumed). CR, LF and NUL behave the same way.
 *
 * These specs are the browser half on purpose: the assertion is
 * `new URL(page.url()).origin`, i.e. where a real browser ended up after
 * following the redirect, not what a string comparison thinks it should do.
 */
const ORIGIN = new URL(readCreds().baseUrl).origin

const HOSTILE = ['/%09//evil', '/%0a//evil', '/%00/x', '/%09%09//evil', '/%0d//evil']

test.describe('I2 next cannot leave the origin', () => {
  for (const raw of HOSTILE) {
    test(`next=${raw} lands on the proxy origin`, async ({ page }) => {
      const link = await magicLinkFor(`i2-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`)
      // String concat, NOT URLSearchParams: the parameter has to reach the hook
      // exactly as the attack sends it (a real `%09` escape in the query, which
      // decodes to a TAB), not double-encoded to a literal "%09".
      await page.goto(`${link}&next=${raw}`)
      expect(new URL(page.url()).origin).toBe(ORIGIN)
    })
  }

  test('a same-origin path is still honoured', async ({ page, request }) => {
    const link = await magicLinkFor(`i2-ok-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`)
    await page.goto(`${link}&next=/some/page?x=1`)
    expect(new URL(page.url()).origin).toBe(ORIGIN)
    expect(new URL(page.url()).pathname).toBe('/some/page')
  })

  test('the sign-in redirect built from X-Forwarded-Uri drops a hostile next', async ({
    request,
  }) => {
    const res = await request.get(`${readCreds().pbUrl}/api/c11n/session`, {
      headers: { accept: 'text/html', 'x-forwarded-uri': '//evil.example/steal' },
      maxRedirects: 0,
    })
    expect(res.status()).toBe(302)
    const location = res.headers()['location']
    const params = new URL(location, ORIGIN).searchParams
    const next = params.get('next')
    // Either dropped, or a value that still resolves onto this origin.
    expect(next === null || new URL(next, ORIGIN).origin === ORIGIN).toBe(true)
  })
})
