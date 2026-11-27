import { expect, test, type Page } from '@playwright/test'
import {
  createUser,
  invitesFor,
  readCreds,
  sessionCookie,
  signInAs,
  superuserTokenFor,
  userByEmail,
} from '../fixtures'

/**
 * 3.8 — the proxy gate — and the overlay half of 3.9.
 *
 * The ADR 0006 model in one sentence: every route except /__c11n/auth/* asks
 * PocketBase's session route first, and /__c11n/pb/* replaces whatever
 * Authorization the client sent with the session cookie. Everything here runs
 * against the real stack, because the invariant lives in the Caddyfile and in
 * the order of directives, not in application code.
 */

const SIGN_IN = '/__c11n/auth/?reason=expired&next='

/** Delete a user as superuser (session invalidation for the expiry spec). */
async function deleteUser(userId: string): Promise<void> {
  const creds = readCreds()
  const res = await fetch(`${creds.pbUrl}/api/collections/users/records/${userId}`, {
    method: 'DELETE',
    headers: { authorization: await superuserTokenFor() },
  })
  expect(res.status, await res.text()).toBe(204)
}

/** localStorage entries as `key=value`, for the no-token assertion. */
async function localStorageDump(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(localStorage).map((k) => `${k}=${localStorage.getItem(k) ?? ''}`),
  )
}

test.describe('3.8 the session gate', () => {
  test('an HTML navigation without a session is sent to the sign-in page', async ({ request }) => {
    const res = await request.get('/', {
      headers: { accept: 'text/html,application/xhtml+xml' },
      maxRedirects: 0,
    })
    expect(res.status()).toBe(302)
    expect(res.headers()['location']).toBe(`${SIGN_IN}%2F`)

    // And the target renders, without a session.
    const page = await request.get('/__c11n/auth/?reason=expired')
    expect(page.status()).toBe(200)
    expect(await page.text()).toContain('Ask your project contact for a new sign-in link.')
  })

  test('a non-HTML request without a session is a 401, not a redirect', async ({ request }) => {
    for (const path of ['/__c11n/overlay.js', '/__c11n/pb/api/health', '/']) {
      const res = await request.get(path, { headers: { accept: '*/*' }, maxRedirects: 0 })
      expect(res.status(), `${path}: ${await res.text()}`).toBe(401)
    }
  })

  test('the gate keeps the requested path in next', async ({ request }) => {
    const res = await request.get('/pricing?utm=1', {
      headers: { accept: 'text/html' },
      maxRedirects: 0,
    })
    expect(res.status()).toBe(302)
    const location = new URL(res.headers()['location']!, 'http://127.0.0.1:18080')
    expect(location.pathname).toBe('/__c11n/auth/')
    expect(location.searchParams.get('reason')).toBe('expired')
    expect(location.searchParams.get('next')).toBe('/pricing?utm=1')
  })

  test('the PocketBase admin UI is 404 with and without a session', async ({ request }) => {
    const anon = await request.get('/__c11n/pb/_/', {
      headers: { accept: 'text/html' },
      maxRedirects: 0,
    })
    expect(anon.status()).toBe(404)

    const cookie = await sessionCookie((await createUser()).email)
    const authed = await request.get('/__c11n/pb/_/', {
      headers: { accept: 'text/html', cookie },
      maxRedirects: 0,
    })
    // Not a redirect to an admin login, not a 200: nothing to see here.
    expect(authed.status()).toBe(404)
  })

  test('a client-sent Authorization is overwritten by the session cookie', async ({ request }) => {
    // A low-privilege user in the cookie jar, and a superuser bearer in the
    // header. If Caddy forwarded the bearer, this endpoint would answer 200.
    const client = await createUser(undefined, 'Cookie Client')
    const cookie = await sessionCookie(client.email)
    const superuser = await superuserTokenFor()

    const res = await request.get('/__c11n/pb/api/collections/_superusers/records', {
      headers: { cookie, authorization: superuser },
    })
    expect([403, 404]).toContain(res.status())
    expect(res.status()).not.toBe(200)

    // Control: the same bearer straight to PocketBase, without the proxy, is a
    // superuser — so the 403 above is the overwrite, not a broken fixture.
    const creds = readCreds()
    const direct = await request.get(`${creds.pbUrl}/api/collections/_superusers/records`, {
      headers: { authorization: superuser },
    })
    expect(direct.status(), await direct.text()).toBe(200)
  })

  test('with a session, `/` is 200 with the overlay injected, as the cookie user', async ({
    page,
  }) => {
    const { user } = await signInAs(page, undefined, 'team')
    const res = await page.goto('/')

    expect(res?.status()).toBe(200)
    expect(await page.content()).toContain('/__c11n/overlay.js')
    await expect(page.locator('.c11n-toolbar')).toContainText(user.name)
    // The admin surface stays closed even to a signed-in user.
    const admin = await page.goto('/__c11n/pb/_/')
    expect(admin?.status()).toBe(404)
  })

  test('the page holds no c11n or PocketBase token in localStorage', async ({ page }) => {
    await signInAs(page)

    // Iterate every key, not a known name: a future SDK default would add a
    // different one.
    const dump = await localStorageDump(page)
    expect(dump.filter((entry) => /c11n|pocketbase|pb_auth|auth/i.test(entry))).toEqual([])
  })

  test('logout clears the cookie and the next navigation is gated again', async ({ page, context }) => {
    await signInAs(page)
    expect((await context.cookies()).some((c) => c.name === 'c11n_session')).toBe(true)

    // The overlay's sign-out is a chip in the toolbar: drive the real path.
    await page.locator('.c11n-signout').click()
    await expect(page).toHaveURL(/\/__c11n\/auth\/\?reason=signed-out/)

    const cookies = await context.cookies()
    expect(cookies.find((c) => c.name === 'c11n_session')).toBeUndefined()
    await expect(page.locator('#signin-message')).toHaveText("You've been signed out.")

    const res = await page.goto('/')
    expect(res?.url()).toContain('/__c11n/auth/?reason=expired')
  })

  test('a session whose user is gone is refused on the next load', async ({ page }) => {
    const { user } = await signInAs(page)
    // Leave the overlay first: once the user is gone, the live overlay's own
    // central-401 handler (any realtime/API call) can navigate to the sign-in
    // page and abort our goto below (seen as net::ERR_ABORTED in CI). This
    // spec is about the *next load*, so start it from a blank page.
    await page.goto('about:blank')
    await deleteUser(user.id)

    // The cookie is still in the jar, but the token no longer resolves.
    const res = await page.goto('/')
    expect(res?.status()).toBe(200)
    expect(page.url()).toContain('/__c11n/auth/?reason=expired')
    await expect(page.locator('#signin-message')).toContainText('session has expired')
  })
})

test.describe('3.9 overlay identity and invites', () => {
  test('a team user sees Invite, a client user does not', async ({ page }) => {
    await signInAs(page, undefined, 'client')
    await page.locator('.c11n-sidebar-toggle').click()
    await expect(page.locator('.c11n-sidebar')).toBeVisible()
    expect(await page.locator('.c11n-invite').count()).toBe(0)
  })

  test('team invites a client through the UI; the link signs a fresh browser in', async ({
    page,
    browser,
  }) => {
    await signInAs(page, undefined, 'team')
    await page.locator('.c11n-sidebar-toggle').click()

    const invite = page.locator('.c11n-invite')
    await expect(invite).toBeVisible()

    // ADR 0008: team cannot create team (or owner) accounts.
    const roles = await invite.locator('.c11n-invite-role option').allTextContents()
    expect(roles).toEqual(['client'])

    const email = `invited-client-${Date.now()}@example.test`
    await invite.locator('.c11n-invite-email').fill(email)
    await invite.locator('.c11n-invite-submit').click()

    const linkInput = invite.locator('.c11n-invite-link')
    await expect(linkInput).toBeVisible()
    const link = await linkInput.inputValue()
    // Fragment, not query: no server (and no request log) ever sees the token.
    expect(link).toContain('/__c11n/auth/#t=')

    // The Copy button is part of the MVP UX; in headless the clipboard may be
    // unavailable, so the assertion is that the click is handled and the label
    // flips (the fallback selects the text in the field).
    await invite.locator('.c11n-invite-copy').click()
    await expect(invite.locator('.c11n-invite-copy')).toHaveText('Copied')

    // A FRESH context: a different cookie jar, like the invitee's browser.
    const ctx = await browser.newContext()
    try {
      const invitee = await ctx.newPage()
      const res = await invitee.goto(link)
      expect(res?.status()).toBe(200)
      // The page does not sign in on GET: the reviewer clicks Continue, and the
      // page POSTs the claim (unfurlers cannot burn the link).
      await invitee.locator('#signin-continue').click()
      await expect(invitee.locator('.c11n-toolbar')).toContainText(email.split('@')[0])
      // Signed in as the client, not as the inviter.
      const who = await invitee.evaluate(async () => {
        const r = await fetch('/__c11n/pb/api/c11n/me')
        return r.ok ? ((await r.json()) as { email: string; role: string }) : null
      })
      expect(who).toEqual({ email, role: 'client', id: expect.any(String), name: expect.any(String) })
    } finally {
      await ctx.close()
    }

    // The invite row is spent and belongs to the inviter's team member.
    const rows = await invitesFor(email)
    expect(rows[0].usedAt).not.toBe('')
    expect((await userByEmail(email))!.role).toBe('client')
  })

  test('an owner can invite a team member (role select offers team)', async ({ page }) => {
    await signInAs(page, undefined, 'owner')
    await page.locator('.c11n-sidebar-toggle').click()

    const invite = page.locator('.c11n-invite')
    const roles = await invite.locator('.c11n-invite-role option').allTextContents()
    expect(roles).toEqual(['team', 'client', 'owner'])

    const email = `invited-team-${Date.now()}@example.test`
    await invite.locator('.c11n-invite-email').fill(email)
    await invite.locator('.c11n-invite-role').selectOption('team')
    await invite.locator('.c11n-invite-submit').click()
    await expect(invite.locator('.c11n-invite-link')).toBeVisible()
    expect((await userByEmail(email))!.role).toBe('team')
  })
})
