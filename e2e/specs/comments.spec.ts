import { expect, test, type Page } from '@playwright/test'
import {
  createUser,
  defaultProjectId,
  listComments,
  listReplies,
  loginAs,
  resetData,
  seedComment,
  userToken,
} from '../fixtures'

/**
 * Core comment flow against the real stack.
 *
 * Specs marked `test.fail()` / `test.fixme()` describe the CORRECT behaviour
 * of a known open bug and stay visible until Phase 2 fixes it:
 *   - B3  (fixme, ~5/10 flaky): pins stay display:none until scroll/resize
 *   - B4  (fail, 10/10): a saved comment renders two pins (realtime echo)
 *   - reply echo (fixme, 10/10 in isolation): a UI reply renders twice
 * Each becomes a passing spec the moment its fix lands.
 *
 * Pins are `.c11n-pin` inside the overlay's open shadow root; Playwright's CSS
 * locators pierce it. B3 leaves pins with `display:none` until a scroll or
 * resize, so DOM-presence assertions (`toHaveCount`) are used wherever
 * visibility is not the subject — otherwise the bug would masquerade as
 * "there is no comment".
 */

const PASSWORD = 'password123456'

test.beforeEach(async () => {
  await resetData()
})

/** Sign in as a fresh user and land on `path` with the overlay ready. */
async function signedIn(page: Page, email: string, name = 'Tester', path = '/'): Promise<void> {
  await page.goto(path)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await loginAs(page, email, PASSWORD)
}

/** Create a comment through the UI: pick the h1, type, Save. */
async function createViaUi(page: Page, body: string): Promise<void> {
  await page.locator('.c11n-mode-toggle').click()
  await page.locator('h1').click()
  await expect(page.locator('.c11n-composer textarea')).toBeVisible()
  await page.locator('.c11n-composer textarea').fill(body)
  await page.locator('.c11n-composer-save').click()
}

test.describe('B2 — comment creation', () => {
  test('UI create finishes quickly and stores seq 1', async ({ page }) => {
    const user = await createUser(undefined, 'B2 Creator')
    await signedIn(page, user.email, user.name)

    const started = Date.now()
    await createViaUi(page, 'first comment')
    // B2 (the seq hook) used to hang this write until PocketBase restarted.
    await expect(page.locator('.c11n-composer')).toHaveCount(0, { timeout: 5_000 })
    expect(Date.now() - started).toBeLessThan(5_000)

    await expect
      .poll(async () => (await listComments()).map((c) => c.seq), { timeout: 5_000 })
      .toEqual([1])
  })

  // B2b regression: simultaneous creates used to race on MAX(seq) — the read
  // took no write lock, so several requests got 400 validation_not_unique
  // against idx_comments_project_seq (reproduced 9/10 under --repeat-each=10).
  // The hook now takes the write lock first (counter table), so this must pass
  // every time it runs.
  test('10 parallel creates get unique seqs 1..10', async ({ request }) => {
    const user = await createUser(undefined, 'B2 Parallel')
    const token = await userToken(user.email)
    const project = await defaultProjectId()

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        request.post('/__c11n/pb/api/collections/comments/records', {
          headers: { authorization: token },
          data: {
            project,
            path: '/',
            selector: 'h1',
            body: `parallel ${i}`,
            author: user.id,
          },
        }),
      ),
    )

    const statuses = responses.map((r) => r.status())
    expect(statuses).toEqual(Array(10).fill(200))
    const seqs = await Promise.all(responses.map(async (r) => ((await r.json()) as { seq: number }).seq))
    expect([...seqs].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(new Set(seqs).size).toBe(10)
    expect((await listComments()).length).toBe(10)
  })

  test('a client-supplied seq is ignored (hook owns it)', async ({ request }) => {
    const user = await createUser(undefined, 'B2 Client Seq')
    const token = await userToken(user.email)
    const project = await defaultProjectId()

    const res = await request.post('/__c11n/pb/api/collections/comments/records', {
      headers: { authorization: token },
      data: { project, path: '/', selector: 'h1', body: 'sneaky', author: user.id, seq: 999 },
    })
    expect(res.status()).toBe(200)
    expect(((await res.json()) as { seq: number }).seq).toBe(1)
    expect((await listComments()).map((c) => c.seq)).toEqual([1])
  })
})

test.describe('B3 — pins visible on load', () => {
  // B3: pins hidden until scroll/resize; see assessment.
  // fixme: the failure is a race with the tracker's first rAF (a fast comment
  // load lands before it, a slow one after), reproduced 5/10 under
  // --repeat-each=10 — `test.fail()` would flake, so this stays skipped until
  // Phase 2's recompute-on-target-change fix makes it deterministic.
  test.fixme('a seeded comment renders its pin without scroll or resize', async ({ page }) => {
    const user = await createUser(undefined, 'B3 Seeder')
    await seedComment({ author: user.id, path: '/', selector: '#hero-title', body: 'anchored' })

    await signedIn(page, user.email, user.name)
    // No scrolling, no resizing, just time.
    await page.waitForTimeout(1500)

    const pin = page.locator('.c11n-pin')
    await expect(pin).toHaveCount(1)
    await expect(pin).toBeVisible()

    const pinBox = await pin.boundingBox()
    const h1Box = await page.locator('#hero-title').boundingBox()
    expect(pinBox).not.toBeNull()
    expect(h1Box).not.toBeNull()
    // Pin sits just right of the element's right edge...
    expect(Math.abs(pinBox!.x - (h1Box!.x + h1Box!.width))).toBeLessThanOrEqual(60)
    // ...and overlaps its vertical band.
    expect(pinBox!.y).toBeLessThan(h1Box!.y + h1Box!.height)
    expect(pinBox!.y + pinBox!.height).toBeGreaterThan(h1Box!.y)
  })
})

test.describe('B4 — one pin per saved comment', () => {
  // B4: duplicate pin from realtime echo. Reproduced 10/10 under
  // --repeat-each=10 (the pin count reaches 2 inside the 2 s poll window).
  test.fail('saving a comment renders exactly one pin', async ({ page }) => {
    const user = await createUser(undefined, 'B4 Saver')
    await signedIn(page, user.email, user.name)

    await createViaUi(page, 'only once')

    // Poll for the duplicate for 2 s: the realtime create can land before or
    // after the HTTP response, so a single snapshot is not enough.
    const counts = new Set<number>()
    for (let i = 0; i < 20; i++) {
      counts.add(await page.locator('.c11n-pin').count())
      await page.waitForTimeout(100)
    }
    expect([...counts].sort()).toEqual([1])
  })
})

test.describe('realtime', () => {
  test('a second user sees the new comment without reloading', async ({ browser }) => {
    const alice = await createUser(undefined, 'Alice')
    const bob = await createUser(undefined, 'Bob')

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await signedIn(pageB, bob.email, bob.name)
      await signedIn(pageA, alice.email, alice.name)
      await expect(pageB.locator('.c11n-pin')).toHaveCount(0)

      await createViaUi(pageA, 'hello from alice')

      // B3 may leave Bob's pin display:none, so assert on the DOM count.
      await expect(pageB.locator('.c11n-pin')).toHaveCount(1, { timeout: 5_000 })
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})

test.describe('SPA navigation', () => {
  test('a comment on / does not follow you to /pricing', async ({ page }) => {
    const user = await createUser(undefined, 'Nav User')
    await seedComment({ author: user.id, path: '/', selector: '#hero-title', body: 'home only' })

    await signedIn(page, user.email, user.name)
    await expect(page.locator('.c11n-pin')).toHaveCount(1)

    await page.getByRole('link', { name: 'Pricing' }).click()
    await expect(page).toHaveURL(/\/pricing$/)
    await expect(page.locator('.c11n-pin')).toHaveCount(0)

    await page.goBack()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.locator('.c11n-pin')).toHaveCount(1)
  })
})

test.describe('reply and resolve', () => {
  test('a reply reaches both users, resolve clears the pin', async ({ browser }) => {
    const alice = await createUser(undefined, 'Alice')
    const bob = await createUser(undefined, 'Bob')
    const seeded = await seedComment({
      author: bob.id,
      path: '/',
      selector: '#hero-title',
      body: 'needs a reply',
    })

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await signedIn(pageA, alice.email, alice.name)
      await signedIn(pageB, bob.email, bob.name)

      // B3 leaves pins display:none, so open the thread from the sidebar row
      // (same store action `openThread`) instead of clicking a pin that
      // Playwright cannot see.
      await pageA.locator('.c11n-sidebar-toggle').click()
      await expect(pageA.locator('.c11n-sidebar-row')).toHaveCount(1)
      await pageA.locator('.c11n-sidebar-row').click()
      await expect(pageA.locator('.c11n-popover')).toBeVisible()

      await pageA.locator('.c11n-popover-reply-text').fill('replied by alice')
      await pageA.locator('.c11n-reply-submit').click()
      // `.first()` on purpose: the reply is currently rendered twice (see the
      // `rendered once` spec below). This spec is about delivery, not dedupe.
      await expect(pageA.locator('.c11n-popover-reply-body').first()).toHaveText(
        'replied by alice',
      )
      expect((await listReplies(seeded.id)).length).toBe(1)

      // Bob opens the same thread and sees the reply (fetched on open).
      await pageB.locator('.c11n-sidebar-toggle').click()
      await expect(pageB.locator('.c11n-sidebar-row')).toHaveCount(1)
      await pageB.locator('.c11n-sidebar-row').click()
      await expect(pageB.locator('.c11n-popover-reply-body').first()).toHaveText(
        'replied by alice',
        { timeout: 10_000 },
      )

      // Resolve from Alice's open thread: the pin disappears...
      await pageA.locator('.c11n-popover-resolve').click()
      await expect(pageA.locator('.c11n-popover')).toHaveCount(0)
      await expect(pageA.locator('.c11n-pin')).toHaveCount(0, { timeout: 5_000 })

      // ...and the thread moves to the sidebar's Resolved tab (patched by the
      // realtime update event, so give it a retry window).
      await pageA.getByRole('tab', { name: 'Resolved', exact: true }).click()
      await expect(pageA.locator('.c11n-sidebar-row')).toHaveCount(1)
      await expect(pageA.locator('.c11n-sidebar-row')).toContainText('needs a reply')

      const stored = (await listComments()).find((c) => c.id === seeded.id)
      expect(stored?.resolved).toBe(true)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })

  // Found by this harness, not in the assessment: the reply realtime echo is
  // not deduped the way comments are, so one stored reply can render as two
  // <li> (1 row in the DB, 2 `.c11n-popover-reply-body` in the DOM).
  // fixme, not fail: reproduced 10/10 in isolation (--repeat-each=10) but it
  // also depends on whether the realtime echo beats the HTTP response, and one
  // full-suite run rendered a single reply — a `test.fail()` would flake.
  test.fixme('a UI reply is rendered once', async ({ page }) => {
    const user = await createUser(undefined, 'Reply Echo')
    const seeded = await seedComment({
      author: user.id,
      path: '/',
      selector: '#hero-title',
      body: 'reply here',
    })

    await signedIn(page, user.email, user.name)
    await page.locator('.c11n-sidebar-toggle').click()
    await page.locator('.c11n-sidebar-row').click()

    await page.locator('.c11n-popover-reply-text').fill('echo me')
    await page.locator('.c11n-reply-submit').click()

    await expect(page.locator('.c11n-popover-reply-body')).toHaveCount(1, { timeout: 5_000 })
    expect((await listReplies(seeded.id)).length).toBe(1)
  })
})
