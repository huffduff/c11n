import { expect, test, type Page } from '@playwright/test'
import {
  claimInvite,
  createUser,
  inviteAs,
  magicLinkFor,
  readCreds,
  resetData,
  sessionCookie,
  signInAs,
  superuserTokenFor,
} from '../fixtures'

/**
 * The minor bundle from the final Phase 3 security review.
 *
 *   M-1  the sign-in page drops `#t=` from the URL immediately, and every
 *        /__c11n/auth/* response is uncacheable
 *   M-2  the hooks read the FIRST c11n_session cookie, like Caddy does
 *   M-3  API, gate-302 and gate-401 responses carry Cache-Control: no-store
 *   M-4  any 401 from any backend call sends the overlay to the sign-in page
 *   M-5  the claim route compares the exact media type (json-patch is 415)
 *   M-6  the legacy magic route is gone: a static 302, never PocketBase
 */

const creds = readCreds()
const PB = creds.pbUrl

async function allLogs(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const read = async () => {
    const res = await request.get(`${PB}/api/logs?perPage=500&sort=-created`, {
      headers: { authorization: await superuserTokenFor() },
    })
    expect(res.status(), await res.text()).toBe(200)
    return (await res.json()) as { items: unknown[]; totalItems: number }
  }
  // PocketBase flushes its request-log buffer every few seconds: wait for the
  // first non-empty read, or the "no token in _logs" assertion below would be
  // vacuously true on an empty table.
  await expect.poll(async () => (await read()).totalItems, { timeout: 15_000 }).toBeGreaterThan(0)
  return JSON.stringify((await read()).items)
}

test.describe('M-1 the sign-in page forgets the token fragment', () => {
  test('the #t= token leaves the URL at once and the page is not cacheable', async ({ page }) => {
    const link = await magicLinkFor(`m1-${Date.now()}@example.test`)
    expect(link).toContain('#t=')

    const response = await page.goto(link)
    expect(response, 'the sign-in page answered').not.toBeNull()
    // The token was read (the continue button proves it) and then removed
    // from the address bar, so a screenshot / shared URL / bookmark cannot
    // carry it.
    await expect(page.locator('#signin-continue')).toBeVisible()
    expect(page.url()).not.toContain('#t=')
    expect(page.url()).toContain('/__c11n/auth/')

    const headers = response!.headers()
    expect(headers['cache-control'], 'the sign-in page is private and uncacheable').toContain('no-store')
  })

  test('the claim response is uncacheable too', async ({ request }) => {
    const link = await magicLinkFor(`m1-claim-${Date.now()}@example.test`)
    const res = await request.post(`${creds.baseUrl}/__c11n/auth/claim`, {
      headers: { 'content-type': 'application/json', origin: creds.baseUrl },
      data: { t: new URL(link).hash.replace(/^#t=/, '') },
    })
    expect(res.status(), await res.text()).toBe(200)
    expect(res.headers()['cache-control']).toContain('no-store')
  })
})

test.describe('M-2 the hooks read the first c11n_session cookie', () => {
  test('first wins, exactly like Caddy {http.request.cookie.*}', async ({ request }) => {
    const user = await createUser(undefined, 'M2 User', 'client')
    const good = await sessionCookie(user.email)

    const firstGood = await request.get(`${PB}/api/c11n/session`, {
      headers: { cookie: `${good}; c11n_session=bogus`, accept: 'application/json' },
    })
    expect(firstGood.status(), 'the first cookie is the one that counts').toBe(200)

    const firstBad = await request.get(`${PB}/api/c11n/session`, {
      headers: { cookie: `c11n_session=bogus; ${good}`, accept: 'application/json' },
    })
    expect(firstBad.status(), 'a later valid cookie must not rescue a bad first one').toBe(401)

    // Same rule on the other two routes that resolve the cookie.
    const meFirstGood = await request.get(`${PB}/api/c11n/me`, {
      headers: { cookie: `${good}; c11n_session=bogus` },
    })
    expect(meFirstGood.status()).toBe(200)
    const meFirstBad = await request.get(`${PB}/api/c11n/me`, {
      headers: { cookie: `c11n_session=bogus; ${good}` },
    })
    expect(meFirstBad.status()).toBe(401)
  })
})

test.describe('M-3 cache headers on the API and the gate', () => {
  test('API, gate 302 and gate 401 are all private, no-store', async ({ request }) => {
    const user = await createUser(undefined, 'M3 User', 'client')
    const cookie = await sessionCookie(user.email)

    const api = await request.get(`${creds.baseUrl}/__c11n/pb/api/c11n/me`, {
      headers: { cookie, accept: 'application/json' },
    })
    expect(api.status()).toBe(200)
    expect(api.headers()['cache-control'], 'API responses are uncacheable').toContain('no-store')

    // A gated HTML navigation with no session: the gate's 302 to the sign-in
    // page (forward_auth relays the hook's response).
    const redirect = await request.get(`${creds.baseUrl}/`, {
      headers: { accept: 'text/html' },
      maxRedirects: 0,
    })
    expect(redirect.status()).toBe(302)
    expect(redirect.headers()['location']).toContain('/__c11n/auth/')
    expect(redirect.headers()['cache-control'], 'the gate 302 is uncacheable').toContain('no-store')

    // A gated API call with no session: 401.
    const unauthorized = await request.get(`${creds.baseUrl}/__c11n/pb/api/c11n/me`, {
      headers: { accept: 'application/json' },
    })
    expect(unauthorized.status()).toBe(401)
    expect(unauthorized.headers()['cache-control'], 'the gate 401 is uncacheable').toContain('no-store')
  })
})

test.describe('M-4 any 401 sends the overlay to the sign-in page', () => {
  test('two tabs: signing out in one makes a write in the other land on sign-in', async ({
    page,
  }) => {
    await resetData()
    const user = await createUser(undefined, 'M4 Two Tabs', 'client')
    await signInAs(page, user.email, 'client')

    const other = await page.context().newPage()
    await other.goto('/')
    await expect(other.locator('.c11n-mode-toggle')).toBeVisible()

    // Sign out in tab 1: the cookie is cleared here and the user's tokenKey is
    // rotated server-side, so tab 2's next request is a 401.
    await page.locator('.c11n-signout').click()
    await page.waitForURL(/\/__c11n\/auth\//)

    // A write in tab 2 (creating a comment) is not `me()`: the 401 has to be
    // handled centrally, or the overlay would just show an error toast while
    // the user believes they are still signed in.
    await writeViaUi(other, 'written after sign-out')

    await other.waitForURL(/\/__c11n\/auth\/\?reason=expired/, { timeout: 10_000 })
    expect(other.url()).toContain('/__c11n/auth/')
    await other.close()
  })
})

/** Create a comment through the UI: pick the h1, type, Save. */
async function writeViaUi(page: Page, body: string): Promise<void> {
  await page.locator('.c11n-mode-toggle').click()
  await page.locator('h1').click()
  await expect(page.locator('.c11n-composer textarea')).toBeVisible()
  await page.locator('.c11n-composer textarea').fill(body)
  await page.locator('.c11n-composer-save').click()
}

test.describe('M-5 the claim route takes exactly application/json', () => {
  test('application/json-patch+json is a 415 and does not spend the invite', async ({ request }) => {
    const email = `m5-${Date.now()}@example.test`
    const link = await magicLinkFor(email)
    const res = await claimInvite(request, link, { contentType: 'application/json-patch+json' })
    expect(res.status, res.body).toBe(415)

    // Parameters on the real media type are still fine (a browser may add
    // charset), which the fixtures already rely on.
    const ok = await claimInvite(request, link, { contentType: 'application/json; charset=utf-8' })
    expect(ok.status, ok.body).toBe(200)
  })
})

test.describe('M-6 the legacy magic route never reaches PocketBase', () => {
  test('a ?t= GET is a static 302 and leaves no token in _logs', async ({ request }) => {
    const email = `m6-legacy-${Date.now()}@example.test`
    const invited = await inviteAs(request, null, email, 'client')
    expect(invited.status, invited.text).toBe(200)
    const token = new URL(invited.link!).hash.replace(/^#t=/, '')
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const res = await request.get(`${creds.baseUrl}/__c11n/auth/magic?t=${token}`, {
      maxRedirects: 0,
    })
    expect(res.status()).toBe(302)
    expect(res.headers()['location']).toBe('/__c11n/auth/?reason=legacy')
    expect(res.headers()['set-cookie']).toBeUndefined()

    // The whole point of removing the hook route: PocketBase's request logger
    // stores the URL, so a request that reached it would write the token to
    // _logs. Nothing may.
    expect(await allLogs(request)).not.toContain(token)

    // And the hook route itself is gone, not merely unreachable through Caddy.
    const direct = await request.get(`${PB}/api/c11n/auth/magic`, { maxRedirects: 0 })
    expect(direct.status()).toBe(404)
  })
})
