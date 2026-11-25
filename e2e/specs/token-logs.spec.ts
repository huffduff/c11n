import { expect, test } from '@playwright/test'
import { inviteAs, invitesFor, readCreds, stackLog, superuserTokenFor } from '../fixtures'

/**
 * I3 (security review) — a raw magic token must never reach a log table.
 *
 * Two leaks: `bootstrap.pb.js` handed the whole link to `e.app.logger()`, which
 * PocketBase persists to `_logs`, and PocketBase's request logger stores every
 * request URL — so a `?t=<token>` link was written to `_logs` on every open.
 *
 * The fixes are (a) stdout only for the one-time bootstrap link, and (b) the
 * token moved out of the request entirely: links carry it in the URL fragment
 * (`#t=`), which browsers never send, and the single-use claim is a POST body.
 *
 * These specs read `_logs` as superuser and assert that no raw token value
 * appears anywhere in it, and that the operator can still find the bootstrap
 * link in stdout (`.stack/pocketbase.log`).
 */

/** Every `_logs` row, serialised: a token may hide in `message` or `data`. */
async function allLogs(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const creds = readCreds()
  const res = await request.get(`${creds.pbUrl}/api/logs?perPage=500&sort=-created`, {
    headers: { authorization: await superuserTokenFor() },
  })
  expect(res.status(), await res.text()).toBe(200)
  const body = (await res.json()) as { items: unknown[]; totalItems: number }
  expect(body.totalItems).toBeGreaterThan(0)
  return JSON.stringify(body.items)
}

test.describe('I3 raw tokens never reach the log tables', () => {
  test('the bootstrap link is printed to stdout and its token is in no log row', async ({
    request,
  }) => {
    const stdout = stackLog('pocketbase')
    // Links are minted as .../__c11n/auth/#t=<token>: the fragment is never
    // sent to a server, so neither the request log nor the referer can see it.
    const match = stdout.match(/__c11n\/auth\/#t=([A-Za-z0-9_-]{43})/)
    expect(match, 'the bootstrap link must be in .stack/pocketbase.log in fragment form').not.toBeNull()
    const token = match![1]
    expect(await allLogs(request)).not.toContain(token)
  })

  test('claiming a fresh invite leaves no raw token in _logs', async ({ request }) => {
    const creds = readCreds()
    const invite = await inviteAs(request, null, `i3-${Date.now()}@example.test`, 'client')
    expect(invite.status, invite.text).toBe(200)
    const token = new URL(invite.link!).hash.replace(/^#t=/, '')
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const claimed = await request.post(`${creds.pbUrl}/api/c11n/auth/claim`, {
      headers: { 'content-type': 'application/json', origin: creds.baseUrl },
      data: { t: token },
    })
    expect(claimed.status(), await claimed.text()).toBe(200)
    expect(await allLogs(request)).not.toContain(token)
  })

  test('a legacy GET link with ?t= no longer claims and mints no cookie', async ({ request }) => {
    const creds = readCreds()
    const email = `i3-legacy-${Date.now()}@example.test`
    const invite = await inviteAs(request, null, email, 'client')
    const token = new URL(invite.link!).hash.replace(/^#t=/, '')
    const res = await request.get(
      `${creds.pbUrl}/api/c11n/auth/magic?t=${encodeURIComponent(token)}`,
      { maxRedirects: 0 },
    )
    expect(res.status()).toBe(302)
    expect(res.headers()['location']).toBe('/__c11n/auth/?reason=legacy')
    expect(res.headers()['set-cookie']).toBeUndefined()

    // Still unused: an unfurler (or anyone) GETting an old-style link cannot
    // burn it.
    const rows = await invitesFor(email)
    expect(rows[0].usedAt).toBe('')
  })
})
