import { expect, test } from '@playwright/test'
import { createUser, readCreds, sessionCookie, signInAs } from '../fixtures'

/**
 * I-2 (security review): the reviewed upstream must never see or set the
 * session cookie.
 *
 * Caddy reads `c11n_session` from the browser and turns it into `Authorization`
 * for `__c11n/pb/*`, but the upstream (the site under review, and every script
 * it loads) used to receive the same cookie on every request. That made the
 * reviewed app — inside the trust boundary per ADR 0002, but still the place a
 * third-party script can run — the easiest place to steal the bearer. And an
 * upstream `Set-Cookie: c11n_session=…` could replace the session outright.
 *
 * The fix is two header ops in the upstream reverse_proxy: strip only the
 * `c11n_session` cookie from the request, and rename it on the way back out.
 * `GET /__echo` (a test-only route in the go fixture) reports the headers the
 * upstream actually received and can emit two Set-Cookie headers, so both
 * directions and Caddy's per-value behaviour are observable.
 *
 * Go fixture only: /__echo exists only in examples/demo-go-server.
 */

test.skip(
  (process.env.C11N_FIXTURE ?? 'vite') !== 'go',
  'the /__echo fixture route exists only in the go fixture',
)

const creds = readCreds()

interface Echo {
  method: string
  path: string
  query: string
  headers: Record<string, string[]>
}

function header(echo: Echo, name: string): string {
  return (echo.headers[name] ?? []).join('; ')
}

/** One request through the proxy with an explicit Cookie header, no browser. */
async function echoWithCookie(
  request: import('@playwright/test').APIRequestContext,
  cookie: string,
): Promise<Echo> {
  const res = await request.get(`${creds.baseUrl}/__echo`, {
    headers: { cookie, accept: 'application/json' },
  })
  expect(res.status(), await res.text()).toBe(200)
  return (await res.json()) as Echo
}

test.describe('I-2 the upstream never sees the session cookie', () => {
  test('every cookie position is stripped and the app cookie survives', async ({ request }) => {
    const user = await createUser(undefined, 'I2 Header', 'client')
    const session = await sessionCookie(user.email)
    const token = session.slice('c11n_session='.length)

    const cases = [
      { name: 'only cookie', cookie: session, mustContain: [] as string[] },
      { name: 'first', cookie: `${session}; app=1; z=2`, mustContain: ['app=1', 'z=2'] },
      { name: 'middle', cookie: `app=1; ${session}; z=2`, mustContain: ['app=1', 'z=2'] },
      { name: 'last', cookie: `app=1; z=2; ${session}`, mustContain: ['app=1', 'z=2'] },
    ]

    for (const c of cases) {
      const echo = await echoWithCookie(request, c.cookie)
      const received = header(echo, 'Cookie')
      expect(received, `${c.name}: upstream Cookie header`).not.toContain('c11n_session')
      expect(received, `${c.name}: upstream Cookie header`).not.toContain(token)
      for (const expected of c.mustContain) {
        expect(received, `${c.name}: app cookie must pass through`).toContain(expected)
      }
    }
  })

  test('identity is still conveyed to the upstream via X-C11n-User/X-C11n-Role', async ({
    request,
  }) => {
    const user = await createUser(undefined, 'I2 Identity', 'team')
    const echo = await echoWithCookie(request, await sessionCookie(user.email, 'team'))
    // Documented, intentional interface (ADR 0002): a user id and a role, no
    // credential. The reviewed app needs to know who is looking at it.
    expect(header(echo, 'X-C11n-User')).toBe(user.id)
    expect(header(echo, 'X-C11n-Role')).toBe('team')
  })

  test('an upstream Set-Cookie cannot replace the session, but its own cookie works', async ({
    page,
  }) => {
    const signedIn = await signInAs(page, undefined, 'client')
    const before = (await page.context().cookies()).find((c) => c.name === 'c11n_session')
    expect(before?.value).toBeTruthy()

    // The app's own cookie in the request direction.
    await page.evaluate(() => {
      document.cookie = 'app_cookie=from-browser; Path=/'
    })
    const seen = await page.evaluate(async () => {
      const res = await fetch('/__echo', { credentials: 'same-origin' })
      return (await res.json()) as Echo
    })
    expect(header(seen, 'Cookie')).toContain('app_cookie=from-browser')

    // The hostile response: two Set-Cookie headers, one of them c11n_session.
    const planted = await page.evaluate(async () => {
      const res = await fetch('/__echo?setcookie=1', { credentials: 'same-origin' })
      return res.status
    })
    expect(planted).toBe(200)

    const cookies = await page.context().cookies()
    const after = cookies.find((c) => c.name === 'c11n_session')
    expect(after?.value, 'the session cookie is untouched').toBe(before?.value)
    expect(cookies.find((c) => c.name === 'app_cookie')?.value, "the app's own cookie is set").toBe('1')

    // Still a live session: the proxy gate accepts it on the next API call.
    const me = await page.evaluate(async () => {
      const res = await fetch('/__c11n/pb/api/c11n/me', { credentials: 'same-origin' })
      return { status: res.status, id: ((await res.json()) as { id?: string }).id }
    })
    expect(me.status).toBe(200)
    expect(me.id).toBe(signedIn.user.id)
  })
})
