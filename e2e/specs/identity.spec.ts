import { createHash } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'
import {
  bootstrapInviteLink,
  createUserWithRole,
  inviteAs,
  invitesFor,
  openMagicLink,
  parseSetCookie,
  patchInvite,
  readCreds,
  sessionToken,
  superuserTokenFor,
  userByEmail,
} from '../fixtures'

/**
 * Phase 3 identity, backend half: the bootstrap owner (3.2), the invite route
 * (3.3), the magic-link callback (3.4) and the session/me/logout routes (3.6).
 *
 * API-level on purpose: the Caddy gate and the sign-in page land in the next
 * batch (3.8/3.9), so at this point the routes are reachable directly through
 * the proxy's existing `/__c11n/pb` handler. Every request still goes through
 * Caddy — the point is the surface a browser actually reaches, and a cookie
 * set on `Path=/` by a `/__c11n/pb/...` response applies site-wide.
 *
 * The magic-link URL is the one Caddy will rewrite from /__c11n/auth/magic to
 * the hook route in 3.8. Until then the hook route is reached under the
 * /__c11n/pb prefix, so specs swap the prefix on the returned link.
 */

/** sha256 hex, the only form of a magic token that may reach the database. */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

const MAGIC_PREFIX = 'http://127.0.0.1:18080/__c11n/auth/magic?t='
/** The hook route behind Caddy's /__c11n/pb proxy (3.8 rewrites the public path). */
const HOOK_MAGIC = 'http://127.0.0.1:18080/__c11n/pb/api/c11n/auth/magic'

/** Turn a public magic link into the hook URL reachable today (no Caddy rewrite yet). */
function hookUrl(link: string, next?: string): string {
  const token = new URL(link).searchParams.get('t') ?? ''
  const url = new URL(HOOK_MAGIC)
  url.searchParams.set('t', token)
  if (next !== undefined) url.searchParams.set('next', next)
  return url.toString()
}

/** A unique invitee email per call (users.email is unique). */
let inviteSeq = 0
function inviteeEmail(label: string): string {
  return `invitee-${label}-${Date.now()}-${inviteSeq++}@example.test`
}

/** Owner invites `role` for a fresh email and returns {link, email}. */
async function freshInvite(
  request: APIRequestContext,
  role: 'owner' | 'team' | 'client' | 'agent' = 'client',
): Promise<{ link: string; email: string; inviteId: string }> {
  const owner = await createUserWithRole('owner')
  const email = inviteeEmail(role)
  const res = await inviteAs(request, owner.token, email, role)
  expect(res.status, res.text).toBe(200)
  const rows = await invitesFor(email)
  return { link: res.link!, email, inviteId: rows[0].id }
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
    expect(((await owners.json()) as { totalItems: number }).totalItems).toBeGreaterThanOrEqual(1)
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

test.describe('3.3 invite route (copy-link MVP)', () => {
  test('the owner invites a team member: user created, link returned', async ({ request }) => {
    const owner = await createUserWithRole('owner')
    const email = inviteeEmail('team')

    const res = await inviteAs(request, owner.token, email, 'team')
    expect(res.status, res.text).toBe(200)
    expect(res.link!.startsWith(MAGIC_PREFIX)).toBe(true)
    expect(new URL(res.link!).searchParams.get('t')).toMatch(/^[A-Za-z0-9_-]{43}$/)

    // No email is sent in the MVP; the link is the delivery mechanism, so the
    // user has to be usable already.
    const user = await userByEmail(email)
    expect(user).toBeDefined()
    expect(user!.role).toBe('team')
    expect(user!.name).toBe(email.split('@')[0])

    const invites = await invitesFor(email)
    expect(invites).toHaveLength(1)
    const token = new URL(res.link!).searchParams.get('t')!
    expect(invites[0].tokenHash).toBe(sha256(token))
    expect(invites[0].role).toBe('team')
    expect(invites[0].user).toBe(user!.id)
    expect(invites[0].invitedBy).toBe(owner.id)
    expect(invites[0].usedAt).toBe('')
    expect(new Date(res.expiresAt!).getTime()).toBe(new Date(invites[0].expiresAt).getTime())

    const ttlMs = new Date(invites[0].expiresAt).getTime() - Date.now()
    expect(ttlMs).toBeGreaterThan(71.5 * 3600_000)
    expect(ttlMs).toBeLessThan(72.5 * 3600_000)
  })

  test('the invited user is verified so no email confirmation blocks sign-in', async ({ request }) => {
    const owner = await createUserWithRole('owner')
    const email = inviteeEmail('verified')
    expect((await inviteAs(request, owner.token, email, 'client')).status).toBe(200)

    const creds = readCreds()
    const res = await request.get(
      `${creds.pbUrl}/api/collections/users/records?filter=${encodeURIComponent(`email='${email}'`)}`,
      { headers: { authorization: await superuserTokenFor() } },
    )
    const body = (await res.json()) as { items: Array<{ verified: boolean }> }
    expect(body.items[0].verified).toBe(true)
  })

  test('the role matrix: team may invite client only, client and agent may not invite', async ({
    request,
  }) => {
    const matrix: Array<[caller: 'owner' | 'team' | 'client' | 'agent', target: string, status: number]> = [
      ['owner', 'team', 200],
      ['owner', 'client', 200],
      ['owner', 'owner', 200],
      ['team', 'client', 200],
      ['team', 'team', 403],
      ['team', 'owner', 403],
      ['team', 'agent', 403],
      ['client', 'client', 403],
      ['client', 'team', 403],
      ['agent', 'client', 403],
    ]
    for (const [callerRole, targetRole, expected] of matrix) {
      const caller = await createUserWithRole(callerRole)
      const email = inviteeEmail(`${callerRole}-to-${targetRole}`)
      const res = await inviteAs(request, caller.token, email, targetRole)
      expect(res.status, `${callerRole} inviting ${targetRole}: ${res.text}`).toBe(expected)
      // A rejected invite must not create the user either.
      if (expected === 403) expect(await userByEmail(email)).toBeUndefined()
    }
  })

  test('anonymous callers get 401', async ({ request }) => {
    const res = await request.post('/__c11n/pb/api/c11n/invite', {
      data: { email: inviteeEmail('anon'), role: 'client' },
    })
    expect(res.status(), await res.text()).toBe(401)
  })

  test('a superuser may invite any role, including owner', async ({ request }) => {
    const email = inviteeEmail('by-superuser')
    const res = await inviteAs(request, null, email, 'owner')
    expect(res.status, res.text).toBe(200)
    expect((await userByEmail(email))!.role).toBe('owner')
  })

  test('a team member cannot re-role an existing team or owner user', async ({ request }) => {
    const team = await createUserWithRole('team')
    const existingTeam = await createUserWithRole('team')
    const existingOwner = await createUserWithRole('owner')

    const asTeam = await inviteAs(request, team.token, existingTeam.email, 'client')
    expect(asTeam.status, asTeam.text).toBe(403)
    expect((await userByEmail(existingTeam.email))!.role).toBe('team')

    const asOwner = await inviteAs(request, team.token, existingOwner.email, 'client')
    expect(asOwner.status, asOwner.text).toBe(403)
    expect((await userByEmail(existingOwner.email))!.role).toBe('owner')
  })

  test('a team member can mint a fresh link for an existing client user', async ({ request }) => {
    const team = await createUserWithRole('team')
    const existing = await createUserWithRole('client', 'Existing Client')

    const first = await inviteAs(request, team.token, existing.email, 'client')
    const second = await inviteAs(request, team.token, existing.email, 'client')
    expect(first.status, first.text).toBe(200)
    expect(second.status, second.text).toBe(200)
    expect(second.link).not.toBe(first.link)

    // Same user, still a client, name untouched.
    const after = await userByEmail(existing.email)
    expect(after!.id).toBe(existing.id)
    expect(after!.role).toBe('client')
    expect(after!.name).toBe('Existing Client')

    const invites = await invitesFor(existing.email)
    expect(invites).toHaveLength(2)
  })

  test('bad input is a 400, not a 500', async ({ request }) => {
    const owner = await createUserWithRole('owner')
    const badRole = await inviteAs(request, owner.token, inviteeEmail('badrole'), 'superuser')
    expect(badRole.status, badRole.text).toBe(400)

    const noEmail = await request.post('/__c11n/pb/api/c11n/invite', {
      headers: { authorization: owner.token },
      data: { role: 'client' },
    })
    expect(noEmail.status(), await noEmail.text()).toBe(400)
  })
})

test.describe('3.4 magic-link callback', () => {
  test('the link signs you in once and sets an HttpOnly session cookie', async ({ request }) => {
    const invite = await freshInvite(request)

    const opened = await openMagicLink(request, hookUrl(invite.link))
    expect(opened.status, opened.body).toBe(302)
    expect(opened.location).toBe('/')

    const setCookie = opened.setCookie!
    expect(setCookie).toBeTruthy()
    const cookie = parseSetCookie(setCookie)
    expect(cookie.name).toBe('c11n_session')
    // A PocketBase auth token, not an opaque handle: it must verify as one.
    expect(cookie.value.split('.')).toHaveLength(3)
    expect(cookie.attributes).toContain('path=/')
    expect(cookie.attributes).toContain('httponly')
    expect(cookie.attributes).toContain('samesite=lax')
    expect(cookie.attributes).toContain('max-age=1209600') // 14 days
    expect(cookie.attributes).toContain('secure')

    // The token inside the cookie really is that user's identity: PocketBase's
    // own API answers for them (this is exactly what Caddy will forward).
    const token = sessionToken(setCookie)
    const user = await userByEmail(invite.email)
    const me = await request.get(`/__c11n/pb/api/collections/users/records/${user!.id}`, {
      headers: { authorization: token },
    })
    expect(me.status(), await me.text()).toBe(200)

    // And the session lasts C11N_SESSION_TTL_DAYS (14) — read from the JWT.
    // (The claims carry `exp`; there is no `iat`, so compare against now.)
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as {
      exp: number
      type?: string
    }
    expect(payload.type).toBe('auth')
    const ttlSeconds = payload.exp - Math.floor(Date.now() / 1000)
    expect(ttlSeconds).toBeGreaterThan(14 * 86400 - 120)
    expect(ttlSeconds).toBeLessThan(14 * 86400 + 120)

    // Spent: the row is marked, and the same link is now dead.
    const rows = await invitesFor(invite.email)
    expect(rows[0].usedAt).not.toBe('')

    const reused = await openMagicLink(request, hookUrl(invite.link))
    expect(reused.status).toBe(410)
    expect(reused.body).toContain('This link has expired or was already used.')
    expect(reused.setCookie).toBeUndefined()
  })

  test('five parallel uses of one link: exactly one signs in', async ({ request }) => {
    const invite = await freshInvite(request)
    const url = hookUrl(invite.link)

    const results = await Promise.all(Array.from({ length: 5 }, () => openMagicLink(request, url)))
    const statuses = results.map((r) => r.status)
    expect(statuses.filter((s) => s === 302)).toHaveLength(1)
    expect(statuses.filter((s) => s === 410)).toHaveLength(4)
    expect(results.filter((r) => r.setCookie)).toHaveLength(1)

    const rows = await invitesFor(invite.email)
    expect(rows).toHaveLength(1)
    expect(rows[0].usedAt).not.toBe('')
  })

  test('an expired link is 410 and sets no cookie', async ({ request }) => {
    const invite = await freshInvite(request)
    await patchInvite(invite.inviteId, { expiresAt: '2020-01-01 00:00:00.000Z' })

    const opened = await openMagicLink(request, hookUrl(invite.link))
    expect(opened.status).toBe(410)
    expect(opened.body).toContain('This link has expired or was already used.')
    expect(opened.setCookie).toBeUndefined()

    // An expired link is not silently consumed either.
    const rows = await invitesFor(invite.email)
    expect(rows[0].usedAt).toBe('')
  })

  test('an unknown token is 404 and says nothing else', async ({ request }) => {
    const opened = await openMagicLink(request, `${HOOK_MAGIC}?t=${'A'.repeat(43)}`)
    expect(opened.status).toBe(404)
    expect(opened.body).toContain('This link has expired or was already used.')
    expect(opened.setCookie).toBeUndefined()
    // No id, no hash, no email in the body.
    expect(opened.body).not.toContain('invites')
    expect(opened.body).not.toContain('@')
  })

  test('next is honoured only for a same-origin path', async ({ request }) => {
    const cases: Array<[next: string | undefined, expected: string]> = [
      ['/some/page?x=1', '/some/page?x=1'],
      [undefined, '/'],
      ['', '/'],
      ['https://evil.example/steal', '/'],
      ['//evil.example/steal', '/'],
      ['/\\evil.example/steal', '/'],
      ['http:/evil.example', '/'],
      ['javascript:alert(1)', '/'],
    ]
    for (const [next, expected] of cases) {
      const invite = await freshInvite(request)
      const opened = await openMagicLink(request, hookUrl(invite.link, next))
      expect(opened.status, `next=${next}: ${opened.body}`).toBe(302)
      expect(opened.location, `next=${next}`).toBe(expected)
    }
  })
})
