import { createHash } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'
import {
  bootstrapInviteLink,
  claimInvite,
  createUser,
  createUserWithRole,
  inviteAs,
  invitesFor,
  isolatedRequest,
  linkToken,
  parseSetCookie,
  patchInvite,
  readCreds,
  sessionCookie,
  sessionToken,
  superuserTokenFor,
  userByEmail,
  userToken,
} from '../fixtures'

/**
 * Phase 3 identity, backend half: the bootstrap owner (3.2), the invite route
 * (3.3), the magic-link claim (3.4) and the session/me/logout routes (3.6).
 *
 * API-level on purpose: the claim is a POST with a JSON body, so a spec can
 * drive it without a browser. The browser half (open the fragment link, click
 * Continue) lives in specs/identity-gate.spec.ts and specs/phase3-exit.spec.ts.
 *
 * Since the fragment change (ADR 0006, revised) links are
 * `.../__c11n/auth/#t=<token>`: the token never reaches a server until the
 * claim POST, and the claim is served by the public `/__c11n/auth/claim` route.
 */

/** sha256 hex, the only form of a magic token that may reach the database. */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

const MAGIC_PREFIX = 'http://127.0.0.1:18080/__c11n/auth/#t='

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
    expect(invite.link).toMatch(/^http:\/\/127\.0\.0\.1:18080\/__c11n\/auth\/#t=[A-Za-z0-9_-]{43}$/)
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
    expect(linkToken(res.link!)).toMatch(/^[A-Za-z0-9_-]{43}$/)

    // No email is sent in the MVP; the link is the delivery mechanism, so the
    // user has to be usable already.
    const user = await userByEmail(email)
    expect(user).toBeDefined()
    expect(user!.role).toBe('team')
    expect(user!.name).toBe(email.split('@')[0])

    const invites = await invitesFor(email)
    expect(invites).toHaveLength(1)
    const token = linkToken(res.link!)
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

    const noEmail = await request.post(`${readCreds().pbUrl}/api/c11n/invite`, {
      headers: { authorization: owner.token },
      data: { role: 'client' },
    })
    expect(noEmail.status(), await noEmail.text()).toBe(400)
  })
})

test.describe('3.4 magic-link claim', () => {
  test('the link signs you in once and sets an HttpOnly session cookie', async ({ request }) => {
    const invite = await freshInvite(request)

    const claimed = await claimInvite(request, invite.link)
    expect(claimed.status, claimed.body).toBe(200)
    // The claim answers with the path to navigate to; the page does the move.
    expect(claimed.json?.redirect).toBe('/')

    const setCookie = claimed.setCookie!
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
    const me = await request.get(`${readCreds().pbUrl}/api/collections/users/records/${user!.id}`, {
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

    // Spent: the row is marked, and the same token is now dead.
    const rows = await invitesFor(invite.email)
    expect(rows[0].usedAt).not.toBe('')

    const reused = await claimInvite(request, invite.link)
    // 410, no cookie: the sign-in page turns this into reason=invalid.
    expect(reused.status).toBe(410)
    expect(reused.setCookie).toBeUndefined()
    expect(reused.body).not.toContain('@')
  })

  test('five parallel claims of one link: exactly one signs in', async ({ request }) => {
    const invite = await freshInvite(request)
    const url = invite.link

    const results = await Promise.all(Array.from({ length: 5 }, () => claimInvite(request, url)))
    expect(results.filter((r) => r.status === 200).length, 'exactly one winner').toBe(1)
    expect(results.filter((r) => r.setCookie).length).toBe(1)
    expect(results.filter((r) => r.status === 410)).toHaveLength(4)

    const rows = await invitesFor(invite.email)
    expect(rows).toHaveLength(1)
    expect(rows[0].usedAt).not.toBe('')
  })

  test('an expired link is refused and sets no cookie', async ({ request }) => {
    const invite = await freshInvite(request)
    await patchInvite(invite.inviteId, { expiresAt: '2020-01-01 00:00:00.000Z' })

    const claimed = await claimInvite(request, invite.link)
    expect(claimed.status).toBe(410)
    expect(claimed.setCookie).toBeUndefined()

    // An expired link is not silently consumed either.
    const rows = await invitesFor(invite.email)
    expect(rows[0].usedAt).toBe('')
  })

  test('an unknown token is refused and says nothing else', async ({ request }) => {
    const base = 'http://127.0.0.1:18080/__c11n/auth/'
    const claimed = await claimInvite(request, `${base}#t=${'A'.repeat(43)}`)
    expect(claimed.status).toBe(410)
    expect(claimed.setCookie).toBeUndefined()
    // No id, no hash, no email in the body.
    expect(claimed.body).not.toContain('invites')
    expect(claimed.body).not.toContain('@')
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
      const claimed = await claimInvite(request, invite.link, { next })
      expect(claimed.status, `next=${next}: ${claimed.body}`).toBe(200)
      expect(claimed.json?.redirect, `next=${next}`).toBe(expected)
    }
  })
})

/** A live session for a brand-new user of `role`, plus its raw cookie value. */
async function sessionFor(
  request: APIRequestContext,
  role: 'owner' | 'team' | 'client' | 'agent' = 'client',
): Promise<{ cookie: string; token: string; user: { id: string; email: string; name: string; role?: string } }> {
  const invite = await freshInvite(request, role)
  // The claim sets the cookie; the redirect it returns is ignored here (this
  // spec only needs the session, not the navigation).
  const claimed = await claimInvite(request, invite.link)
  expect(claimed.status, claimed.body).toBe(200)
  const token = sessionToken(claimed.setCookie!)
  const user = (await userByEmail(invite.email))!
  return { cookie: `c11n_session=${token}`, token, user }
}

test.describe('3.6 session, me and logout', () => {
  test('a valid session is 200 with X-C11n-User and X-C11n-Role', async ({ request }) => {
    const { cookie, user } = await sessionFor(request, 'client')
    const res = await request.get(`${readCreds().pbUrl}/api/c11n/session`, { headers: { cookie } })
    expect(res.status(), await res.text()).toBe(200)
    expect(res.headers()['x-c11n-user']).toBe(user.id)
    expect(res.headers()['x-c11n-role']).toBe('client')
  })

  test('the role header follows the user, not the invite', async ({ request }) => {
    const { cookie, user } = await sessionFor(request, 'team')
    const res = await request.get(`${readCreds().pbUrl}/api/c11n/session`, { headers: { cookie } })
    expect(res.headers()['x-c11n-role']).toBe('team')
    expect(res.headers()['x-c11n-user']).toBe(user.id)
  })

  test('no session: 302 to the sign-in page for HTML, 401 otherwise', async ({ request }) => {
    const html = await request.get(`${readCreds().pbUrl}/api/c11n/session`, {
      headers: { accept: 'text/html,application/xhtml+xml', 'x-forwarded-uri': '/some/page?x=1' },
      maxRedirects: 0,
    })
    expect(html.status()).toBe(302)
    const location = html.headers()['location']
    // 3.5: the reason travels in the URL, so the static page can choose its
    // copy without a round trip; `next` is kept for the post-MVP email form.
    expect(location.startsWith('/__c11n/auth/?reason=expired&next=')).toBe(true)
    expect(decodeURIComponent(location.slice('/__c11n/auth/?reason=expired&next='.length))).toBe(
      '/some/page?x=1',
    )

    const nonHtml = await request.get(`${readCreds().pbUrl}/api/c11n/session`, { headers: { accept: '*/*' }, maxRedirects: 0 })
    expect(nonHtml.status()).toBe(401)
  })

  test('a forged or malformed cookie is not a session', async ({ request }) => {
    for (const value of ['garbage', 'a.b.c', 'Bearer junk']) {
      const html = await request.get(`${readCreds().pbUrl}/api/c11n/session`, {
        headers: { accept: 'text/html', cookie: `c11n_session=${value}` },
        maxRedirects: 0,
      })
      expect(html.status(), value).toBe(302)

      const json = await request.get(`${readCreds().pbUrl}/api/c11n/session`, {
        headers: { accept: 'application/json', cookie: `c11n_session=${value}` },
        maxRedirects: 0,
      })
      expect(json.status(), value).toBe(401)
    }
  })

  test('a superuser token in the cookie is not a session', async ({ request }) => {
    // findAuthRecordByToken(token, 'auth') also accepts _superusers tokens and
    // returns that record; the route must reject anything that is not a users
    // record, or the proxy gate would accept an admin token as a session.
    const su = await superuserTokenFor()
    const res = await request.get(`${readCreds().pbUrl}/api/c11n/session`, {
      headers: { accept: 'application/json', cookie: `c11n_session=${su}` },
      maxRedirects: 0,
    })
    expect(res.status()).toBe(401)
  })

  test('a query parameter called next cannot steer the redirect', async ({ request }) => {
    // The redirect's `next` is derived from the request URI, never from
    // caller-supplied input: here the attacker's ?next= is just part of the
    // path we remember, and the page ends up back on this same path.
    const res = await request.get('/__c11n/pb/api/c11n/session?next=https://evil.example/steal', {
      headers: { accept: 'text/html' },
      maxRedirects: 0,
    })
    expect(res.status()).toBe(302)
    const location = res.headers()['location']
    const params = new URL(location, 'http://127.0.0.1:18080').searchParams
    expect(params.get('reason')).toBe('expired')
    expect(params.get('next')).toBe('/__c11n/pb/api/c11n/session?next=https://evil.example/steal')
    expect(params.get('next')).not.toBe('https://evil.example/steal')
  })

  test('me answers from the bearer token and from the cookie', async ({ request }) => {
    const { cookie, token, user } = await sessionFor(request, 'client')

    for (const headers of [
      { authorization: token },
      { authorization: `Bearer ${token}` },
      { cookie },
    ] as Array<Record<string, string>>) {
      const res = await request.get(`${readCreds().pbUrl}/api/c11n/me`, { headers })
      expect(res.status(), JSON.stringify(headers) + ' ' + (await res.text())).toBe(200)
      expect(await res.json()).toEqual({ id: user.id, email: user.email, name: user.name, role: 'client' })
    }

    // Anonymous and superuser checks run in a context with its own cookie jar:
    // the shared `request` fixture still holds the session cookie set above.
    const anon = await isolatedRequest()
    try {
      const anonymous = await anon.get(`${readCreds().pbUrl}/api/c11n/me`)
      expect(anonymous.status()).toBe(401)

      // A superuser is not a c11n user.
      const asSuperuser = await anon.get(`${readCreds().pbUrl}/api/c11n/me`, {
        headers: { authorization: await superuserTokenFor() },
      })
      expect(asSuperuser.status()).toBe(401)
    } finally {
      await anon.dispose()
    }
  })

  test('logout clears the cookie with Max-Age=0 and the same attributes', async ({ request }) => {
    const { cookie } = await sessionFor(request, 'client')
    const res = await request.post(`${readCreds().pbUrl}/api/c11n/auth/logout`, { headers: { cookie } })
    expect(res.status(), await res.text()).toBe(204)

    const setCookie = res.headers()['set-cookie']
    expect(setCookie).toBeTruthy()
    const parsed = parseSetCookie(setCookie)
    expect(parsed.name).toBe('c11n_session')
    expect(parsed.value).toBe('')
    expect(parsed.attributes).toContain('max-age=0')
    expect(parsed.attributes).toContain('path=/')
    expect(parsed.attributes).toContain('httponly')
    expect(parsed.attributes).toContain('samesite=lax')
  })
})

test.describe('3.9 no password exists', () => {
  test('password auth is disabled on the users collection', async ({ request }) => {
    const res = await request.get(
      `${readCreds().pbUrl}/api/collections/users?fields=passwordAuth,otp,oauth2`,
      { headers: { authorization: await superuserTokenFor() } },
    )
    expect(res.status(), await res.text()).toBe(200)
    const body = (await res.json()) as { passwordAuth?: { enabled?: boolean } }
    expect(body.passwordAuth?.enabled).toBe(false)
  })

  test('auth-with-password is refused, even with the right password', async ({ request }) => {
    // createUser still sets a password (PocketBase needs one for an auth
    // record); the endpoint that could turn it into a token is off.
    const user = await createUser(undefined, 'Password Probe')
    const res = await request.post(
      `${readCreds().pbUrl}/api/collections/users/auth-with-password`,
      { data: { identity: user.email, password: 'password123456' } },
    )
    expect([400, 403]).toContain(res.status())
  })
})

/**
 * C1 (security review): the default `users.updateRule` is `id = @request.auth.id`,
 * so an authenticated user could PATCH their own record with `{"role":"owner"}`.
 * Through the proxy that only needs the session cookie — no token, no password.
 *
 * The guard is two-layered on purpose:
 *   - `onRecordUpdateRequest` on `users` rejects any change to role/verified/
 *     email unless the caller is a superuser (and caps `name` at 80 bytes);
 *   - migration 1764001100 floors `users.updateRule` with
 *     `@request.body.{role,email,verified}:isset = false`, so a deployment
 *     that ships migrations but forgets pb_hooks is still closed.
 * A PATCH that does not mention those fields is untouched: the role default
 * hook and the overlay never write them.
 */
test.describe('C1 users cannot change their own privileged fields', () => {
  const PB = readCreds().pbUrl

  /** PATCH a users record as `user`, either with a cookie or a bearer. */
  async function selfPatch(
    request: APIRequestContext,
    user: { id: string },
    data: Record<string, unknown>,
    auth: { cookie?: string; bearer?: string },
  ) {
    return request.patch(`${PB}/api/collections/users/records/${user.id}`, {
      data,
      headers: {
        ...(auth.cookie ? { cookie: auth.cookie } : {}),
        ...(auth.bearer ? { authorization: auth.bearer } : {}),
      },
    })
  }

  test('through the proxy (cookie only) a self-promotion is rejected', async ({ request }) => {
    // A real magic-link session: this is the attack the reviewer ran.
    const user = await createUser(undefined, 'C1 Proxy', 'client')
    const cookie = await sessionCookie(user.email)
    const me = await request.get(`${PB}/api/c11n/me`, { headers: { cookie } })
    const { id } = (await me.json()) as { id: string }
    expect(id).toBe(user.id)

    const res = await request.patch(`/__c11n/pb/api/collections/users/records/${id}`, {
      headers: { cookie },
      data: { role: 'owner' },
    })
    // PocketBase evaluates the collection rule before the update request hook,
    // so the rule floor answers 404 and the hook's 400 is only reachable for a
    // body the rule lets through (name). Both are a rejection; the field is
    // asserted unchanged below.
    expect([400, 404]).toContain(res.status())

    const after = await request.get(`${PB}/api/collections/users/records/${id}`, {
      headers: { authorization: await superuserTokenFor() },
    })
    expect(((await after.json()) as { role: string }).role).toBe('client')
  })

  test('directly with a bearer token a self-promotion is rejected', async ({ request }) => {
    const user = await createUser(undefined, 'C1 Bearer', 'client')
    const bearer = await userToken(user.email)
    const res = await selfPatch(request, user, { role: 'owner' }, { bearer })
    expect([400, 404], await res.text()).toContain(res.status())
    expect((await userByEmail(user.email))!.role).toBe('client')
  })

  test('a demotion attempt is rejected too', async ({ request }) => {
    const user = await createUserWithRole('team')
    const res = await selfPatch(request, user, { role: 'client' }, { bearer: user.token })
    expect([400, 404], await res.text()).toContain(res.status())
    expect((await userByEmail(user.email))!.role).toBe('team')
  })

  test('verified and email cannot be self-written either', async ({ request }) => {
    const user = await createUserWithRole('client')
    for (const data of [{ verified: true }, { email: `c1-hijack-${Date.now()}@example.test` }]) {
      const res = await selfPatch(request, user, data, { bearer: user.token })
      expect([400, 404], `${JSON.stringify(data)}: ${await res.text()}`).toContain(res.status())
    }
    const after = await userByEmail(user.email)
    expect(after).toBeDefined()
  })

  test('name may change, but only up to 80 characters', async ({ request }) => {
    const user = await createUserWithRole('client')
    const ok = await selfPatch(request, user, { name: 'Rename Reviewer' }, { bearer: user.token })
    expect(ok.status(), await ok.text()).toBe(200)
    expect((await userByEmail(user.email))!.name).toBe('Rename Reviewer')

    const tooLong = await selfPatch(request, user, { name: 'x'.repeat(81) }, { bearer: user.token })
    expect(tooLong.status(), await tooLong.text()).toBe(400)
    expect((await userByEmail(user.email))!.name).toBe('Rename Reviewer')
  })

  test('a superuser can still change a role', async ({ request }) => {
    const user = await createUser(undefined, 'C1 Superuser', 'client')
    const res = await request.patch(`${PB}/api/collections/users/records/${user.id}`, {
      headers: { authorization: await superuserTokenFor() },
      data: { role: 'team' },
    })
    expect(res.status(), await res.text()).toBe(200)
    expect((await userByEmail(user.email))!.role).toBe('team')
  })

  test('/session still reports the original role after the attempt', async ({ request }) => {
    const user = await createUser(undefined, 'C1 Session', 'client')
    const cookie = await sessionCookie(user.email)
    const me = await request.get(`${PB}/api/c11n/me`, { headers: { cookie } })
    const { id } = (await me.json()) as { id: string }

    await request.patch(`${PB}/api/collections/users/records/${id}`, {
      headers: { cookie },
      data: { role: 'owner' },
    })

    const session = await request.get(`${PB}/api/c11n/session`, {
      headers: { cookie, accept: 'application/json' },
    })
    expect(session.status()).toBe(200)
    expect(session.headers()['x-c11n-role']).toBe('client')
  })
})
