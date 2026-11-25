import { expect, test } from '@playwright/test'
import { magicLinkFor, readCreds } from '../fixtures'

/**
 * I2 (security review) — `next` must never leave the proxy's origin.
 *
 * The old validator only looked for `//`, a backslash and `://`. A value like
 * `/%09//evil` passed it: the hook answered with a Location containing a
 * literal TAB, Chromium strips tabs while parsing a URL, and the browser landed
 * on `//evil` (proven in Chromium, not assumed). CR, LF and NUL behave the same
 * way.
 *
 * Since the fragment change the redirect happens after the continue button, so
 * these specs click through exactly like a reviewer: the assertion is
 * `new URL(page.url()).origin`, i.e. where a real browser ended up.
 */
const ORIGIN = new URL(readCreds().baseUrl).origin

const HOSTILE = ['/%09//evil', '/%0a//evil', '/%00/x', '/%09%09//evil', '/%0d//evil']

/** `.../auth/?next=<raw>#t=<token>`: the raw escape has to reach the server. */
function withRawNext(link: string, raw: string): string {
  const hashAt = link.indexOf('#')
  return `${link.slice(0, hashAt)}?next=${raw}${link.slice(hashAt)}`
}

test.describe('I2 next cannot leave the origin', () => {
  for (const raw of HOSTILE) {
    test(`next=${raw} lands on the proxy origin`, async ({ page }) => {
      const link = await magicLinkFor(`i2-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`)
      // String concat, NOT URLSearchParams: the parameter has to reach the hook
      // exactly as the attack sends it (a real `%09` escape in the query, which
      // decodes to a TAB), not double-encoded to a literal "%09".
      await page.goto(withRawNext(link, raw))
      await page.locator('#signin-continue').click()
      await page.waitForURL((url) => !url.pathname.startsWith('/__c11n/auth/'))
      expect(new URL(page.url()).origin).toBe(ORIGIN)
    })
  }

  test('a same-origin path is still honoured', async ({ page }) => {
    const link = await magicLinkFor(`i2-ok-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`)
    await page.goto(withRawNext(link, '/some/page?x=1'))
    await page.locator('#signin-continue').click()
    await page.waitForURL((url) => url.pathname === '/some/page')
    expect(new URL(page.url()).origin).toBe(ORIGIN)
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
