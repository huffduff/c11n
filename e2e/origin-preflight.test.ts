/**
 * Unit tests for the external-mode origin preflight (no network): a stub fetch
 * stands in for the deployed claim route, so both the mismatch and the pass
 * path are exercised exactly as globalSetup would see them.
 *
 * The e2e package is CommonJS, so compile the pair first (type stripping does
 * not apply to a CJS package):
 *
 *   npx tsc e2e/origin-preflight.ts e2e/origin-preflight.test.ts \
 *     --outDir /tmp/preflight --module commonjs --target ES2022 \
 *     --moduleResolution node --esModuleInterop --strict --types node
 *   node --test /tmp/preflight/origin-preflight.test.js
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { checkClaimOrigin, PREFLIGHT_TOKEN } from './origin-preflight'

const BASE = 'http://127.0.0.1:18080'

function responder(status: number, body: string, seen: Array<{ url: string; init: RequestInit }>) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    seen.push({ url, init })
    return new Response(body, { status, headers: { 'content-type': 'application/json' } })
  }
}

test('a mismatched publicUrl fails with the origin and the fix', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = []
  await assert.rejects(
    checkClaimOrigin(BASE, responder(403, JSON.stringify({ message: 'cross-origin claim refused' }), seen)),
    (err: Error) => {
      assert.match(err.message, /cross-origin/)
      assert.ok(err.message.includes(BASE), 'names the base URL')
      assert.match(err.message, /publicUrl/)
      assert.match(err.message, /E2E_PORT_FORWARD=1/)
      return true
    },
  )
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, `${BASE}/__c11n/auth/claim`)
  assert.equal(seen[0].init.method, 'POST')
  const headers = seen[0].init.headers as Record<string, string>
  assert.equal(headers.origin, BASE)
  assert.equal(headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), { t: PREFLIGHT_TOKEN })
})

test('a matching publicUrl passes on 410 for the bogus token', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = []
  await checkClaimOrigin(BASE, responder(410, JSON.stringify({ message: 'invalid or expired link' }), seen))
  assert.equal(seen.length, 1)
})

test('a trailing slash on the base URL is normalized', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = []
  await checkClaimOrigin(`${BASE}/`, responder(410, '{}', seen))
  assert.equal(seen[0].url, `${BASE}/__c11n/auth/claim`)
  assert.equal((seen[0].init.headers as Record<string, string>).origin, BASE)
})

test('a non-claim 4xx is reported as such, not as a cross-origin refusal', async () => {
  await assert.rejects(
    checkClaimOrigin(BASE, responder(404, 'not found', [])),
    (err: Error) => {
      assert.match(err.message, /expected 410/)
      assert.match(err.message, /404/)
      assert.doesNotMatch(err.message, /publicUrl is not/)
      return true
    },
  )
})

test('an unreachable base URL names the URL', async () => {
  await assert.rejects(
    checkClaimOrigin(BASE, async () => {
      throw new Error('ECONNREFUSED')
    }),
    (err: Error) => {
      assert.match(err.message, /could not reach http:\/\/127\.0\.0\.1:18080\/__c11n\/auth\/claim/)
      assert.match(err.message, /ECONNREFUSED/)
      return true
    },
  )
})
