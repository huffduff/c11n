import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { bootstrapInviteLink, readCreds, superuserTokenFor } from '../fixtures'

/**
 * Phase 3 identity, backend half: the bootstrap owner (3.2), the invite route
 * (3.3), the magic-link callback (3.4) and the session/me/logout routes (3.6).
 *
 * API-level on purpose: the Caddy gate and the sign-in page land in the next
 * batch (3.8/3.9), so at this point the routes are reachable directly through
 * the proxy's existing `/__c11n/pb` handler. Every request still goes through
 * Caddy — the point is the surface a browser actually reaches, and a cookie
 * set on `Path=/` by a `/__c11n/pb/...` response applies site-wide.
 */

/** sha256 hex, the only form of a magic token that may reach the database. */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

test.describe('3.2 bootstrap owner', () => {
  test('a fresh stack logs a one-time owner invite link', () => {
    const invite = bootstrapInviteLink()
    expect(invite.email).toBe('owner@c11n.test')
    expect(invite.ttlHours).toBe(72)
    expect(invite.link).toMatch(/^http:\/\/127\.0\.0\.1:18080\/__c11n\/auth\/magic\?t=[A-Za-z0-9_-]{43}$/)
  })

  test('the bootstrap owner exists, verified, with the owner role and no usable password', async ({
    request,
  }) => {
    const creds = readCreds()
    const headers = { authorization: await superuserTokenFor() }
    const res = await request.get(
      `${creds.pbUrl}/api/collections/users/records?filter=${encodeURIComponent("email='owner@c11n.test'")}`,
      { headers },
    )
    expect(res.ok(), await res.text()).toBeTruthy()
    const body = (await res.json()) as { items: Array<Record<string, unknown>> }
    expect(body.items).toHaveLength(1)
    expect(body.items[0].role).toBe('owner')
    expect(body.items[0].verified).toBe(true)
    expect(body.items[0].name).toBe('owner')

    // Exactly one owner: a restart must not create a second one.
    const owners = await request.get(
      `${creds.pbUrl}/api/collections/users/records?filter=${encodeURIComponent("role='owner'")}`,
      { headers },
    )
    expect(((await owners.json()) as { totalItems: number }).totalItems).toBe(1)
  })

  test('the database holds only the sha256 of the bootstrap token', async ({ request }) => {
    const invite = bootstrapInviteLink()
    const creds = readCreds()
    const res = await request.get(
      `${creds.pbUrl}/api/collections/invites/records?filter=${encodeURIComponent(
        `email='${invite.email}'`,
      )}`,
      { headers: { authorization: await superuserTokenFor() } },
    )
    expect(res.ok(), await res.text()).toBeTruthy()
    const { items } = (await res.json()) as {
      items: Array<{ tokenHash: string; usedAt: string; expiresAt: string; role: string }>
    }
    expect(items).toHaveLength(1)
    expect(items[0].tokenHash).toBe(sha256(invite.token))
    expect(items[0].tokenHash).not.toContain(invite.token)
    expect(items[0].usedAt).toBe('')
    expect(items[0].role).toBe('owner')

    const ttlMs = new Date(items[0].expiresAt).getTime() - Date.now()
    expect(ttlMs).toBeGreaterThan(71.5 * 3600_000)
    expect(ttlMs).toBeLessThan(72.5 * 3600_000)
  })
})
