import { expect, test } from '@playwright/test'
import {
  createUser,
  listComments,
  readCreds,
  resetData,
  seedComment,
  signInAs,
  superuserTokenFor,
  type PbComment,
} from '../fixtures'

/**
 * The overlay half of the ADR 0008 matrix (task 3.10): the buttons a role is
 * allowed to use exist, and the ones it is not are not offered. The backend
 * enforces the same cells independently (`permissions-matrix.spec.ts`); these
 * specs are about what a reviewer sees.
 *
 *   client: no Resolve on someone else's thread, Resolve on its own
 *   owner:  Delete on someone else's comment, and it works
 *   team:   Reopen in the sidebar's Resolved tab, and it works
 */

test.beforeEach(async () => {
  await resetData()
})

/** Flip `resolved` as superuser (the UI specs need a pre-resolved thread). */
async function preResolve(id: string, resolved = true): Promise<void> {
  const creds = readCreds()
  const su = await superuserTokenFor()
  const res = await fetch(`${creds.pbUrl}/api/collections/comments/records/${id}`, {
    method: 'PATCH',
    headers: { authorization: su, 'content-type': 'application/json' },
    body: JSON.stringify({ resolved }),
  })
  if (!res.ok) throw new Error(`preResolve -> ${res.status} ${await res.text()}`)
}

test.describe('overlay role gating', () => {
  test("client sees no Resolve on another's thread, but sees it on its own", async ({ page }) => {
    const { user: client } = await signInAs(page, undefined, 'client')
    const other = await createUser(undefined, 'Someone Else', 'team')
    await seedComment({ author: other.id, body: "someone else's thread" })
    await seedComment({ author: client.id, body: 'my own thread' })

    await page.reload()
    await page.locator('.c11n-sidebar-toggle').click()
    await expect(page.locator('.c11n-sidebar-row')).toHaveCount(2)

    await page.locator('.c11n-sidebar-row', { hasText: "someone else's thread" }).click()
    await expect(page.locator('.c11n-popover')).toBeVisible()
    await expect(page.locator('.c11n-popover-resolve')).toHaveCount(0)

    await page.locator('.c11n-popover-close').click()
    await page.locator('.c11n-sidebar-row', { hasText: 'my own thread' }).click()
    await expect(page.locator('.c11n-popover')).toBeVisible()
    await expect(page.locator('.c11n-popover-resolve')).toBeVisible()

    // The backend agrees: resolving its own thread works from here.
    await page.locator('.c11n-popover-resolve').click()
    await expect(page.locator('.c11n-popover')).toHaveCount(0)
    const stored = (await listComments()).find((c) => c.body === 'my own thread')
    expect(stored?.resolved).toBe(true)
  })

  test("owner sees Delete on another's comment, and it deletes it", async ({ page }) => {
    await signInAs(page, undefined, 'owner')
    const other = await createUser(undefined, 'Client Person', 'client')
    const comment = await seedComment({ author: other.id, body: 'delete this thread' })

    await page.reload()
    await page.locator('.c11n-sidebar-toggle').click()
    await expect(page.locator('.c11n-sidebar-row')).toHaveCount(1)
    await page.locator('.c11n-sidebar-row').click()
    await expect(page.locator('.c11n-popover')).toBeVisible()

    await expect(page.locator('.c11n-popover-delete')).toBeVisible()
    await page.locator('.c11n-popover-delete').click()
    await expect(page.locator('.c11n-popover')).toHaveCount(0)
    await expect(page.locator('.c11n-pin')).toHaveCount(0)
    await expect(page.locator('.c11n-sidebar-row')).toHaveCount(0)

    const remaining = (await listComments()).filter((c: PbComment) => c.id === comment.id)
    expect(remaining).toHaveLength(0)
  })

  test('team reopens a resolved thread from the Resolved tab', async ({ page }) => {
    await signInAs(page, undefined, 'team')
    const other = await createUser(undefined, 'Client Person', 'client')
    const comment = await seedComment({ author: other.id, body: 'resolved thread' })
    await preResolve(comment.id)

    await page.reload()
    await page.locator('.c11n-sidebar-toggle').click()
    await page.getByRole('tab', { name: 'Resolved', exact: true }).click()
    await expect(page.locator('.c11n-sidebar-row')).toHaveCount(1)
    await expect(page.locator('.c11n-sidebar-reopen')).toBeVisible()

    await page.locator('.c11n-sidebar-reopen').click()
    // The row leaves Resolved and lands in Unresolved.
    await expect(page.locator('.c11n-sidebar-row')).toHaveCount(0)
    await page.getByRole('tab', { name: 'Unresolved', exact: true }).click()
    await expect(page.locator('.c11n-sidebar-row')).toHaveCount(1)
    await expect(page.locator('.c11n-sidebar-row')).toContainText('resolved thread')

    const stored = (await listComments()).find((c) => c.id === comment.id)
    expect(stored?.resolved).toBe(false)
  })
})
