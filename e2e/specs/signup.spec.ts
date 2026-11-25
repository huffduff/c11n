import { expect, test, type APIRequestContext } from '@playwright/test'
import { createUser, readCreds, sessionCookie, superuserTokenFor } from '../fixtures'

/**
 * S1 — the default `users` collection ships with `createRule: ""`, i.e. anyone
 * on the internet can create an account in one POST (assessment S1). Phase 2
 * closes it (migration 1764000000_lock_users). Phase 3 replaces password auth
 * with invites altogether.
 *
 * Requests go through the proxy (`/__c11n/pb`, the same origin the overlay
 * uses) for the anonymous and normal-user cases, because that is the surface
 * an attacker actually reaches.
 */
const PASSWORD = 'password123456'

/**
 * Total users in the collection, read as superuser. A rejected signup must not
 * create a row, and the status alone does not prove that (a 403 with a
 * half-written record, or a 200 for a filtered-out create, would both pass a
 * status-only assertion).
 */
async function userCount(request: APIRequestContext): Promise<number> {
  const creds = readCreds()
  const res = await request.get(`${creds.pbUrl}/api/collections/users/records?perPage=1`, {
    headers: { authorization: await superuserTokenFor() },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
  return ((await res.json()) as { totalItems: number }).totalItems
}

test.describe('S1 — public signup is closed', () => {
  test('anonymous signup through the proxy never reaches PocketBase', async ({ request }) => {
    const before = await userCount(request)
    const res = await request.post('/__c11n/pb/api/collections/users/records', {
      data: {
        email: `anon-${Date.now()}@c11n.test`,
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      },
    })
    // Since 3.8 the gate answers first for a request with no session (401, not
    // the 403 `createRule: null` used to give): an anonymous caller cannot even
    // reach the users collection.
    expect(res.status(), await res.text()).toBe(401)
    expect(await userCount(request)).toBe(before)
  })

  test('an authenticated normal user cannot create users', async ({ request }) => {
    const user = await createUser(undefined, 'Signup Probe')
    const cookie = await sessionCookie(user.email)
    const before = await userCount(request)

    const res = await request.post('/__c11n/pb/api/collections/users/records', {
      headers: { cookie },
      data: {
        email: `probe-${Date.now()}@c11n.test`,
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      },
    })
    // Being signed in does not satisfy a superuser-only rule.
    expect(res.status(), await res.text()).toBe(403)
    expect(await userCount(request)).toBe(before)
  })

  test('the superuser can still create users', async ({ request }) => {
    // The fixtures create users as superuser, so this also guards the
    // fixtures themselves against a rule that is too tight.
    const user = await createUser(undefined, 'Superuser Created')
    expect(user.id).toBeTruthy()
    expect(user.email).toMatch(/@c11n\.test$/)

    const creds = readCreds()
    const res = await request.post(`${creds.pbUrl}/api/collections/users/records`, {
      headers: { authorization: await superuserTokenFor() },
      data: {
        email: `admin-created-${Date.now()}@c11n.test`,
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      },
    })
    expect(res.status(), await res.text()).toBe(200)
  })
})
