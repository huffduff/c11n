/**
 * The external-mode origin preflight.
 *
 * The claim route (`POST /__c11n/auth/claim`) refuses any request whose
 * `Origin` is not the deployment's `publicUrl` with 403
 * `cross-origin claim refused` (CSRF, ADR 0006). That is correct behaviour -
 * but when the suite is pointed at http://127.0.0.1:18080 through a
 * port-forward while the release was installed with
 * publicUrl=http://c11n.closedcloud.test, EVERY sign-in in the run fails with
 * a message that names neither the origin nor publicUrl. Forty confusing spec
 * failures instead of one sentence.
 *
 * So globalSetup asks the deployment itself, once, before any spec runs: a
 * claim with a bogus token and Origin = the base URL the tests will use.
 *
 *   - 410 (unknown/invalid token) means the origin was ACCEPTED and PocketBase
 *     answered. That is the pass.
 *   - 403 + "cross-origin" means publicUrl is not this base URL.
 *   - anything else (404, 415, 5xx) means the route or the deployment is not
 *     what this suite expects.
 *
 * The token is not a real invite and is never inserted anywhere: this cannot
 * consume a link or create a session.
 */

/** A token that is syntactically plausible and hashes to nothing invites row. */
export const PREFLIGHT_TOKEN = 'c11n-origin-preflight-not-a-real-token'

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface PreflightOptions {
  timeoutMs?: number
}

/**
 * Throws (with the fix in the message) unless the deployment's claim route
 * accepts `baseUrl` as its own origin. Resolves on the accepted case.
 */
export async function checkClaimOrigin(
  baseUrl: string,
  fetchImpl: FetchLike = fetch,
  options: PreflightOptions = {},
): Promise<void> {
  const origin = baseUrl.replace(/\/+$/, '')
  const url = `${origin}/__c11n/auth/claim`
  const timeoutMs = options.timeoutMs ?? 5000

  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ t: PREFLIGHT_TOKEN }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new Error(`the claim preflight could not reach ${url}: ${(err as Error).message}`)
  }

  const body = await res.text().catch(() => '')

  if (res.status === 403 && /cross-origin/i.test(body)) {
    throw new Error(
      `the deployment at ${origin} refused the claim as cross-origin. Its publicUrl is not ` +
        `${origin}, and the claim's CSRF check compares the browser's Origin to publicUrl ` +
        `(C11N_PUBLIC_URL), so every sign-in would 403. Re-install with the base URL the tests ` +
        `use: E2E_PORT_FORWARD=1 scripts/cluster/install-closedcloud.sh (or ` +
        `--set publicUrl=${origin} --set cookie.secure=true, then restart the pocketbase pod ` +
        `so C11N_PUBLIC_URL is re-read).`,
    )
  }

  // 410 is the route's answer for an unknown/malformed token; getting that far
  // proves the Origin matched. Any other 4xx is a different failure.
  if (res.status !== 410) {
    const detail = body.trim().slice(0, 200).replace(/\s+/g, ' ')
    throw new Error(
      `the claim preflight at ${url} expected 410 (unknown token) but got ${res.status}` +
        `${detail ? `: ${detail}` : ''}. Is this the c11n proxy, and is its pocketbase pod Ready?`,
    )
  }
}
