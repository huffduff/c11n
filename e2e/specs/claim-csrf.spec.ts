import { expect, test } from '@playwright/test'
import {
  claimInvite,
  invitesFor,
  linkToken,
  magicLinkFor,
  openMagicLink,
  readCreds,
} from '../fixtures'

/**
 * The unfurler-proof claim (ADR 0006, revised 2026-11-25).
 *
 * Slackbot, Outlook Safe Links and every other unfurler GETs a pasted link
 * before a human clicks it. Under the old design that GET was the claim, so the
 * invite was spent before its recipient ever saw it. The GET is now only the
 * static sign-in page; the single-use claim is a same-origin POST with a JSON
 * body, which also closes CSRF (a cross-site form cannot set that content type
 * without a CORS preflight, and Origin/Sec-Fetch-Site are checked as well).
 */
test.describe('claim: unfurlers cannot burn it, cross-origin cannot claim', () => {
  test('a GET of the link and of the page does not consume the token', async ({
    page,
    request,
  }) => {
    const email = `unfurl-${Date.now()}@example.test`
    const link = await magicLinkFor(email)

    // 1. What an unfurler does with the raw link. Fragments never leave the
    //    browser, so this is a plain GET of the page.
    const unfurled = await request.get(link)
    expect(unfurled.status()).toBe(200)
    expect(await unfurled.text()).toContain('Continue to review')
    expect((await invitesFor(email))[0].usedAt).toBe('')

    // 2. What a browser does before the click.
    await page.goto(link)
    await expect(page.locator('#signin-continue')).toBeVisible()
    expect((await invitesFor(email))[0].usedAt).toBe('')

    // 3. The human clicks; now it is spent, and only now.
    await page.locator('#signin-continue').click()
    await expect(page.locator('.c11n-toolbar')).toBeVisible()
    expect((await invitesFor(email))[0].usedAt).not.toBe('')
  })

  test('the legacy ?t= GET is inert and leaves the invite unused', async ({ request }) => {
    const email = `unfurl-legacy-${Date.now()}@example.test`
    const link = await magicLinkFor(email)
    const creds = readCreds()
    const res = await openMagicLink(
      request,
      `${creds.baseUrl}/__c11n/auth/magic?t=${linkToken(link)}`,
    )
    expect(res.status).toBe(302)
    expect(res.location).toBe('/__c11n/auth/?reason=legacy')
    expect(res.setCookie).toBeUndefined()
    expect((await invitesFor(email))[0].usedAt).toBe('')
  })

  test('a claim from another origin is refused with 403 and mints no cookie', async ({
    request,
  }) => {
    const email = `csrf-${Date.now()}@example.test`
    const link = await magicLinkFor(email)
    const res = await claimInvite(request, link, { origin: 'https://evil.example' })
    expect(res.status, res.body).toBe(403)
    expect(res.setCookie).toBeUndefined()
    // Still usable: a refused claim must not spend the token.
    expect((await invitesFor(email))[0].usedAt).toBe('')
  })

  test('a claim with no Origin at all is refused', async ({ request }) => {
    const email = `csrf-none-${Date.now()}@example.test`
    const link = await magicLinkFor(email)
    const creds = readCreds()
    const res = await request.post(`${creds.baseUrl}/__c11n/auth/claim`, {
      headers: { 'content-type': 'application/json' },
      data: { t: linkToken(link) },
    })
    expect(res.status(), await res.text()).toBe(403)
  })

  test('a non-JSON content type is refused', async ({ request }) => {
    const email = `csrf-form-${Date.now()}@example.test`
    const link = await magicLinkFor(email)
    const res = await claimInvite(request, link, { contentType: 'text/plain' })
    expect(res.status, res.body).toBe(415)
  })

  test('the same-origin claim succeeds', async ({ request }) => {
    const link = await magicLinkFor(`csrf-ok-${Date.now()}@example.test`)
    const res = await claimInvite(request, link)
    expect(res.status, res.body).toBe(200)
    expect(res.json?.redirect).toBe('/')
    expect(res.setCookie).toBeTruthy()
  })

  test('ten parallel claims: exactly one succeeds', async ({ request }) => {
    const email = `parallel-claim-${Date.now()}@example.test`
    const link = await magicLinkFor(email)
    const results = await Promise.all(Array.from({ length: 10 }, () => claimInvite(request, link)))
    const winners = results.filter((r) => r.status === 200)
    expect(winners.length, 'exactly one winner').toBe(1)
    expect(results.filter((r) => r.status === 410)).toHaveLength(9)
    expect((await invitesFor(email))[0].usedAt).not.toBe('')
  })
})
