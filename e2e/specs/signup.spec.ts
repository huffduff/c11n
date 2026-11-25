import { expect, test } from '@playwright/test'
import { createUser, readCreds, superuserTokenFor, userToken } from '../fixtures'

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

test.describe('S1 — public signup is closed', () => {
  test('anonymous signup through the proxy is rejected', async ({ request }) => {
    const res = await request.post('/__c11n/pb/api/collections/users/records', {
      data: {
        email: `anon-${Date.now()}@c11n.test`,
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      },
    })
    // 400 (rule denies) or 403 (rule not satisfied) — never 200.
    expect([400, 403]).toContain(res.status())
  })

  test('an authenticated normal user cannot create users', async ({ request }) => {
    const user = await createUser(undefined, 'Signup Probe')
    const token = await userToken(user.email)

    const res = await request.post('/__c11n/pb/api/collections/users/records', {
      headers: { authorization: token },
      data: {
        email: `probe-${Date.now()}@c11n.test`,
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      },
    })
    expect([400, 403]).toContain(res.status())
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
