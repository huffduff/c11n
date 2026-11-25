import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import {
  claimInvite,
  createUser,
  createUserWithRole,
  inviteAs,
  invitesFor,
  readCreds,
  sessionCookie,
  superuserTokenFor,
  userByEmail,
} from '../fixtures'

/**
 * The minor hardening bundle from the security review.
 *
 *   M5  logout rotates the user's tokenKey, so every copied cookie dies
 *   M6  invites are rate-limited per inviter (C11N_INVITE_RATE_PER_HOUR)
 *   M7  re-inviting the same user revokes that user's older unused links
 *   M9  a superuser-created user's email is trimmed and lowercased
 */
const PB = readCreds().pbUrl

test.describe('M5 logout revokes every session for the user', () => {
  test('the same cookie and a second session are both dead after logout', async ({ request }) => {
    const user = await createUser(undefined, 'M5 User', 'client')
    const first = await sessionCookie(user.email)
    // A second session in a later second: the static token embeds its expiry,
    // so two mints in the same second are byte-identical.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const second = await sessionCookie(user.email)
    expect(first).not.toBe(second)

    const out = await request.post(`${PB}/api/c11n/auth/logout`, { headers: { cookie: first } })
    expect(out.status()).toBe(204)

    for (const cookie of [first, second]) {
      const res = await request.get(`${PB}/api/c11n/session`, {
        headers: { cookie, accept: 'application/json' },
      })
      expect(res.status()).toBe(401)
    }
  })
})

test.describe('M6 invite quota per inviter', () => {
  test('the 31st invite in an hour is a 429, and a superuser is exempt', async ({ request }) => {
    const team = await createUserWithRole('team')
    const su = { authorization: await superuserTokenFor() }

    // 30 invites already minted by this inviter in the last hour, seeded
    // directly: the quota reads `invites` (invitedBy + created), so the spec
    // does not need to change the process environment.
    for (let i = 0; i < 30; i++) {
      const target = await createUser(undefined, `M6 Target ${i}`, 'client')
      const res = await request.post(`${PB}/api/collections/invites/records`, {
        headers: su,
        data: {
          email: target.email,
          role: 'client',
          user: target.id,
          invitedBy: team.id,
          tokenHash: createHash('sha256').update(`m6-${team.id}-${i}`).digest('hex'),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      })
      expect(res.status(), await res.text()).toBe(200)
    }

    const blocked = await inviteAs(request, team.token, `m6-over-${Date.now()}@example.test`, 'client')
    expect(blocked.status, blocked.text).toBe(429)
    expect(JSON.parse(blocked.text).message).toContain('rate')

    // The break-glass path is not rate limited.
    const asSuperuser = await inviteAs(request, null, `m6-su-${Date.now()}@example.test`, 'client')
    expect(asSuperuser.status, asSuperuser.text).toBe(200)
  })
})

test.describe('M7 re-invite revokes the older unused link', () => {
  test('the old link stops working as soon as a new one is minted', async ({ request }) => {
    const email = `m7-${Date.now()}@example.test`
    const first = await inviteAs(request, null, email, 'client')
    const second = await inviteAs(request, null, email, 'client')
    expect(first.status, first.text).toBe(200)
    expect(second.status, second.text).toBe(200)

    const old = await claimInvite(request, first.link!)
    expect(old.status, old.body).toBe(410)

    const fresh = await claimInvite(request, second.link!)
    expect(fresh.status, fresh.body).toBe(200)

    const rows = await invitesFor(email)
    expect(rows).toHaveLength(2)
    expect(rows.filter((r) => !r.usedAt)).toHaveLength(0)
  })
})

test.describe('M9 email normalization on superuser create', () => {
  test('a mixed-case, padded email is stored trimmed and lowercased', async ({ request }) => {
    const raw = `  M9-${Date.now()}@Example.TEST  `
    const email = raw.trim().toLowerCase()
    const res = await request.post(`${PB}/api/collections/users/records`, {
      headers: { authorization: await superuserTokenFor() },
      data: { email: raw, password: 'password123456', passwordConfirm: 'password123456', name: 'M9' },
    })
    expect(res.status(), await res.text()).toBe(200)
    expect(((await res.json()) as { email: string }).email).toBe(email)
    expect(await userByEmail(email)).toBeDefined()
  })
})
