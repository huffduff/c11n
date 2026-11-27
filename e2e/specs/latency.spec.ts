import { expect, test } from '@playwright/test'
import {
  createUser,
  listComments,
  resetData,
  seedComment,
  seedReply,
  signInAs,
  withPbLatency,
} from '../fixtures'

/**
 * The overlay's UI flows with 300 ms added to every PocketBase round-trip.
 *
 * Reviewers are always remote, and the local stack answers in ~1 ms — fast
 * enough to hide ordering bugs entirely. These four specs failed on the k3s
 * cluster through a port-forward and passed here, and the cause was a race,
 * not latency itself:
 *
 *   the PocketBase SDK keys its automatic request cancellation on
 *   method+path, so the project-wide sidebar list and the per-page list
 *   (same collection) were cancelling each other. The page list aborted, the
 *   store's `items` stayed empty, and every page rendered without pins — the
 *   sidebar row was there, but its thread had nothing to open.
 *
 * So this file keeps the same flows (row → popover, reply, resolve, delete)
 * under the RTT that exposes the race. It is deliberately one route, not CDP
 * throttling: only the overlay's own API prefix is slowed, so page load and
 * the vite dev server keep their timing and the suite stays quick.
 */
test.describe('UI under 300 ms PocketBase latency', () => {
  test.beforeEach(async ({ page }) => {
    await resetData()
    await withPbLatency(page, 300)
  })

  test('a sidebar row click opens the thread popover', async ({ page }) => {
    await signInAs(page, undefined, 'owner')
    const other = await createUser(undefined, 'Client Person', 'client')
    await seedComment({ author: other.id, body: 'delete this thread' })

    await page.reload()
    // The per-page list must survive the sidebar's project-wide fetch that
    // starts right after it; when it does not, the pin never renders and the
    // row's thread has nothing to show.
    await expect(page.locator('.c11n-pin')).toHaveCount(1)

    await page.locator('.c11n-sidebar-toggle').click()
    await expect(page.locator('.c11n-sidebar-row')).toHaveCount(1)
    await page.locator('.c11n-sidebar-row').click()

    await expect(page.locator('.c11n-popover')).toBeVisible()
    await expect(page.locator('.c11n-popover-reply-text')).toBeVisible()
    await expect(page.locator('.c11n-popover-body')).toHaveText('delete this thread')
  })

  test('reply, resolve and delete work with replies already on the thread', async ({ page }) => {
    const owner = await signInAs(page, undefined, 'owner')
    const comment = await seedComment({ author: owner.user.id, body: 'needs a reply' })
    await seedReply(comment.id, owner.user.id, 'seeded reply')

    await page.reload()
    await page.locator('.c11n-sidebar-toggle').click()
    await page.locator('.c11n-sidebar-row').click()
    // The replies of the opened thread, fetched while the lists are still in
    // flight: a reply load cancelled by a later one leaves an empty thread.
    await expect(page.locator('.c11n-popover-reply-body')).toHaveText('seeded reply')

    await page.locator('.c11n-popover-reply-text').fill('answered under latency')
    await page.locator('.c11n-reply-submit').click()
    await expect(page.locator('.c11n-popover-reply-body')).toHaveCount(2)

    await page.locator('.c11n-popover-resolve').click()
    await expect(page.locator('.c11n-popover')).toHaveCount(0)
    await expect(page.locator('.c11n-pin')).toHaveCount(0)

    // Resolved tab → reopen from the row → delete: the row has to stay
    // clickable across the tab switch and the slow list patches behind it.
    await page.getByRole('tab', { name: 'Resolved', exact: true }).click()
    await expect(page.locator('.c11n-sidebar-row')).toHaveCount(1)
    await page.locator('.c11n-sidebar-row').click()
    await expect(page.locator('.c11n-popover')).toBeVisible()
    await page.locator('.c11n-popover-delete').click()
    await expect(page.locator('.c11n-popover')).toHaveCount(0)
    await expect(page.locator('.c11n-sidebar-row')).toHaveCount(0)
    expect((await listComments()).length).toBe(0)
  })
})
