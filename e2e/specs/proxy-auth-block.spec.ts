import { expect, test } from '@playwright/test'
import { createUser, readCreds, sessionCookie } from '../fixtures'

/**
 * I-1 (security review): PocketBase's token-minting auth endpoints must not be
 * reachable through the review host.
 *
 * Caddy injects `Authorization` from the httpOnly `c11n_session` cookie on
 * `/__c11n/pb/*`. That is invisible to page JS — but every PocketBase
 * collection also exposes routes that MINT a bearer token and return it in a
 * JSON body (`auth-refresh` is the obvious one). Any script on the reviewed
 * page could call one of those, read `{token}` from the response, and keep it
 * past the cookie's lifetime. The overlay uses none of them (the backend only
 * talks to `/api/c11n/{me,invite}`, `me()` and the collections it needs), so
 * the proxy answers 403 to all of them before PocketBase sees the request.
 *
 * One spec per endpoint, driven through the proxy with a real client session:
 * a 401 from the gate would prove nothing, so the cookie has to be valid.
 */

const creds = readCreds()

/** Every collection-level route that returns an auth token or changes auth state. */
const BLOCKED = [
  { method: 'POST', path: 'auth-refresh' },
  { method: 'POST', path: 'auth-with-password' },
  { method: 'POST', path: 'auth-with-otp' },
  { method: 'POST', path: 'request-otp' },
  { method: 'POST', path: 'request-password-reset' },
  { method: 'POST', path: 'confirm-password-reset' },
  { method: 'POST', path: 'request-email-change' },
  { method: 'POST', path: 'confirm-email-change' },
  { method: 'POST', path: 'auth-with-oauth2' },
  { method: 'POST', path: 'auth-methods' },
  { method: 'POST', path: 'request-verification' },
  { method: 'POST', path: 'impersonate/' },
] as const

test.describe('I-1 token-minting auth endpoints are blocked at the proxy', () => {
  test('each auth endpoint answers 403 for a signed-in client, and normal API calls still work', async ({
    request,
  }) => {
    const user = await createUser(undefined, 'I1 User', 'client')
    const cookie = await sessionCookie(user.email)

    // The session itself is valid: without this the 403s below could just be
    // the gate's 401.
    const me = await request.get(`${creds.baseUrl}/__c11n/pb/api/c11n/me`, {
      headers: { cookie, accept: 'application/json' },
    })
    expect(me.status(), 'a normal API call through the proxy still works').toBe(200)

    for (const { method, path } of BLOCKED) {
      for (const collection of ['users', '_superusers']) {
        const url =
          `${creds.baseUrl}/__c11n/pb/api/collections/${collection}/${path}` +
          (path === 'impersonate/' ? user.id : '')
        const res = await request.post(url, {
          headers: { cookie, accept: 'application/json', 'content-type': 'application/json' },
          data: method === 'POST' ? { identity: user.email, password: 'x', token: 'x', id: user.id } : undefined,
        })
        const body = await res.text()
        expect(res.status(), `${method} ${url} -> ${res.status()} ${body}`).toBe(403)
        // The point of the block: no token in the body.
        expect(body).not.toContain('"token"')
      }
    }
  })

  test('the routes are blocked before PocketBase sees them (no 200, no 400)', async ({ request }) => {
    const user = await createUser(undefined, 'I1 Unauthed', 'client')
    const cookie = await sessionCookie(user.email)
    // A body PocketBase would reject with 400 proves the request reached it;
    // the block must be a flat 403 with no JSON error from the backend.
    const res = await request.post(
      `${creds.baseUrl}/__c11n/pb/api/collections/users/auth-with-password`,
      { headers: { cookie, accept: 'application/json', 'content-type': 'application/json' }, data: {} },
    )
    expect(res.status()).toBe(403)
    const body = await res.text()
    expect(body).not.toContain('Failed to authenticate')
  })
})
