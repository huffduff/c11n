import { expect, test } from '@playwright/test'

/**
 * 3.7 — the sign-in page.
 *
 * It is served by Caddy at /__c11n/auth/ from packages/signin, and it is one of
 * the few routes with no gate in front of it (3.8): a signed-out user has to be
 * able to reach the page that tells them they are signed out. That is the
 * whole point of these specs — they run with no cookie at all.
 */
const PAGE = '/__c11n/auth/'

test.describe('3.7 sign-in page', () => {
  test('is public, and defaults to the expired-session copy', async ({ page }) => {
    const res = await page.goto(PAGE)
    expect(res?.status()).toBe(200)

    expect(await page.title()).toContain('c11n')
    await expect(page.locator('#signin-message')).toHaveText(
      "Your session has expired or you're not signed in. Ask your project contact for a new sign-in link.",
    )
    // No sign-in form in the MVP: no email field, no password field.
    expect(await page.locator('input').count()).toBe(0)
  })

  test('?reason=signed-out shows the signed-out copy', async ({ page }) => {
    await page.goto(`${PAGE}?reason=signed-out`)
    await expect(page.locator('#signin-message')).toHaveText("You've been signed out.")
  })

  test('?reason=invalid explains a spent or expired link', async ({ page }) => {
    await page.goto(`${PAGE}?reason=invalid`)
    await expect(page.locator('#signin-message')).toHaveText(
      'That link has expired or was already used. Ask your project contact for a new one.',
    )
  })

  test('an unknown reason falls back to the expired copy (no reflection)', async ({ page }) => {
    await page.goto(`${PAGE}?reason=${encodeURIComponent('<script>alert(1)</script>')}`)
    await expect(page.locator('#signin-message')).toHaveText(
      "Your session has expired or you're not signed in. Ask your project contact for a new sign-in link.",
    )
    expect(await page.locator('script').count()).toBe(1) // only our inline script
  })

  test('loads no third-party assets', async ({ page }) => {
    const foreign: string[] = []
    page.on('request', (req) => {
      const url = new URL(req.url())
      if (url.hostname !== '127.0.0.1') foreign.push(req.url())
    })
    await page.goto(PAGE)
    await expect(page.locator('#signin-message')).toBeVisible()
    expect(foreign).toEqual([])
  })
})
