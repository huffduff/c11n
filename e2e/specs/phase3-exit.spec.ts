import { expect, test, type Browser, type Page } from '@playwright/test'
import {
  bootstrapInviteLink,
  invitesFor,
  listComments,
  magicLinkFor,
  resetData,
  userByEmail,
} from '../fixtures'

/**
 * Phase 3 exit (ADR 0006): the whole identity story in one run, in the order a
 * real review happens.
 *
 *   owner (the bootstrap invite) → invites a team member
 *   team member → invites a client
 *   client → signs in by link, comments on the page
 *   team member → resolves the thread
 *
 * Each actor gets its own BrowserContext: a session is a cookie, and three
 * reviewers never share one.
 */

/** Invite someone through the sidebar UI and return the link it renders. */
async function inviteViaUi(
  page: Page,
  email: string,
  role?: 'team' | 'client' | 'owner',
): Promise<string> {
  await page.locator('.c11n-sidebar-toggle').click()
  const invite = page.locator('.c11n-invite')
  await expect(invite).toBeVisible()
  await invite.locator('.c11n-invite-email').fill(email)
  if (role) await invite.locator('.c11n-invite-role').selectOption(role)
  await invite.locator('.c11n-invite-submit').click()
  const linkInput = invite.locator('.c11n-invite-link')
  await expect(linkInput).toBeVisible()
  return linkInput.inputValue()
}

interface Session {
  ctx: Awaited<ReturnType<Browser['newContext']>>
  page: Page
  close: () => Promise<void>
}

async function openAs(browser: Browser, link: string): Promise<Session> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(link)
  // The fragment link only renders the "Continue to review" page; the session
  // comes from the POST the button makes.
  await page.locator('#signin-continue').click()
  await expect(page.locator('.c11n-toolbar')).toBeVisible()
  return { ctx, page, close: () => ctx.close() }
}

test.describe('Phase 3 exit flow', () => {
  test.beforeEach(async () => {
    await resetData()
  })

  test('owner invites team, team invites client, client comments, team resolves', async ({
    browser,
  }) => {
    const stamp = Date.now()
    const teamEmail = `team-${stamp}@example.test`
    const clientEmail = `client-${stamp}@example.test`

    const open: Session[] = []
    try {
      // ---- owner: the operator's path ------------------------------------
      // The one-time link is read out of the PocketBase log, exactly as the
      // runbook says. identity.spec consumes it in one test; if that already
      // happened, mint a fresh link for the same account so this spec stays
      // order-independent.
      const owner = (await userByEmail('owner@c11n.test'))!
      const unused = (await invitesFor(owner.email)).find((row) => !row.usedAt)
      const ownerLink = unused
        ? bootstrapInviteLink().link
        : await magicLinkFor(owner.email, 'owner')

      const asOwner = await openAs(browser, ownerLink)
      open.push(asOwner)
      await expect(asOwner.page.locator('.c11n-toolbar')).toContainText('owner')

      const teamLink = await inviteViaUi(asOwner.page, teamEmail, 'team')
      expect((await userByEmail(teamEmail))!.role).toBe('team')

      // ---- team: invites the client --------------------------------------
      const asTeam = await openAs(browser, teamLink)
      open.push(asTeam)
      await expect(asTeam.page.locator('.c11n-toolbar')).toContainText('team-' + stamp)

      const clientLink = await inviteViaUi(asTeam.page, clientEmail) // default role: client
      expect((await userByEmail(clientEmail))!.role).toBe('client')

      // ---- client: signs in and leaves a comment -------------------------
      const asClient = await openAs(browser, clientLink)
      open.push(asClient)
      await expect(asClient.page.locator('.c11n-toolbar')).toContainText('client-' + stamp)

      await asClient.page.locator('.c11n-mode-toggle').click()
      await asClient.page.locator('h1').first().click()
      await expect(asClient.page.locator('.c11n-composer textarea')).toBeVisible()
      await asClient.page.locator('.c11n-composer textarea').fill('the CTA copy is wrong')
      await asClient.page.locator('.c11n-composer-save').click()
      await expect(asClient.page.locator('.c11n-pin')).toHaveCount(1)

      const comments = await listComments()
      expect(comments).toHaveLength(1)
      expect(comments[0].body).toBe('the CTA copy is wrong')
      // The comment is authored by the client, not by whoever happened to be
      // signed in last: the author id comes from the cookie user.
      expect(comments[0].author).toBe((await userByEmail(clientEmail))!.id)

      // ---- team: resolves it ---------------------------------------------
      await asTeam.page.reload()
      await expect(asTeam.page.locator('.c11n-toolbar')).toBeVisible()
      await asTeam.page.locator('.c11n-sidebar-toggle').click()
      await expect(asTeam.page.locator('.c11n-sidebar-row')).toHaveCount(1)
      await asTeam.page.locator('.c11n-sidebar-row').click()
      await expect(asTeam.page.locator('.c11n-popover')).toBeVisible()
      await asTeam.page.locator('.c11n-popover-resolve').click()

      await expect(asTeam.page.locator('.c11n-pin')).toHaveCount(0)
      expect((await listComments())[0].resolved).toBe(true)

      // The old owner link is single use: opening it and clicking Continue
      // lands on the sign-in page, not a second session.
      const replay = await browser.newContext()
      try {
        const page = await replay.newPage()
        await page.goto(ownerLink)
        await page.locator('#signin-continue').click()
        await expect(page.locator('#signin-message')).toContainText('expired or was already used')
      } finally {
        await replay.close()
      }
    } finally {
      for (const session of open) await session.close().catch(() => {})
    }
  })
})
