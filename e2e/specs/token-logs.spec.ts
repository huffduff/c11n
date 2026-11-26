import { expect, test } from '@playwright/test'
import { EXTERNAL, inviteAs, invitesFor, readCreds, stackLog, superuserTokenFor } from '../fixtures'

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

/**
 * Every `_logs` row, serialised: a token may hide in `message` or `data`.
 *
 * PocketBase buffers request logs and flushes them every few seconds, so a
 * spec that starts from a fresh stack (globalSetup wipes pb_data) sees an
 * empty table for the first ~3 s. Poll for the first flush instead of racing
 * it: with an empty table the `not.toContain` assertions below would pass
 * vacuously.
 */
async function allLogs(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const creds = readCreds()
  const read = async () => {
    const res = await request.get(`${creds.pbUrl}/api/logs?perPage=500&sort=-created`, {
      headers: { authorization: await superuserTokenFor() },
    })
    expect(res.status(), await res.text()).toBe(200)
    return (await res.json()) as { items: unknown[]; totalItems: number }
  }
  await expect.poll(async () => (await read()).totalItems, { timeout: 15_000 }).toBeGreaterThan(0)
  const body = await read()
  return JSON.stringify(body.items)
}

test.describe('I3 raw tokens never reach the log tables', () => {
  // The first spec reads the bootstrap line out of the LOCAL stack log; in
  // external mode that log is `kubectl logs` on a pod this suite cannot read.
  // (The claim/legacy specs below would work, but keeping the file together
  // is simpler than half-running a file about log contents.)
  test.skip(EXTERNAL, 'reads the local stack log; use kubectl logs on the cluster')

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

  test('a legacy GET link with ?t= is answered by Caddy, never PocketBase', async ({ request }) => {
    const creds = readCreds()
    const email = `i3-legacy-${Date.now()}@example.test`
    const invite = await inviteAs(request, null, email, 'client')
    const token = new URL(invite.link!).hash.replace(/^#t=/, '')
    // M-6: the proxy answers this itself, so the request never enters
    // PocketBase's request log (which stores the URL and would keep the token).
    const res = await request.get(
      `${creds.baseUrl}/__c11n/auth/magic?t=${encodeURIComponent(token)}`,
      { maxRedirects: 0 },
    )
    expect(res.status()).toBe(302)
    expect(res.headers()['location']).toBe('/__c11n/auth/?reason=legacy')
    expect(res.headers()['set-cookie']).toBeUndefined()
    expect(await allLogs(request)).not.toContain(token)

    // Still unused: an unfurler (or anyone) GETting an old-style link cannot
    // burn it.
    const rows = await invitesFor(email)
    expect(rows[0].usedAt).toBe('')
  })
})
