import { expect, test } from '@playwright/test'
import { EXTERNAL, GO_PORT, createUser, sessionCookie, signInAs } from '../fixtures'

/**
 * Topology specs: the same proxy, two different upstreams.
 *
 *   go   the built demo-vue served by examples/demo-go-server (Go, production)
 *   vite the demo-vue dev server (today's local dev)
 *
 * Everything here goes through Caddy on :18080, exactly like a reviewer's
 * browser. The fixture-specific specs skip on the other run, so both
 * topologies report the whole suite with the same suite of markers.
 */
const fixture = process.env.C11N_FIXTURE ?? 'vite'
const overlayTag = '/__c11n/overlay.js'
const goUpstream = `http://127.0.0.1:${GO_PORT}`

test.describe('go-served production topology', () => {
  test.skip(fixture !== 'go', 'go fixture only; run npm run e2e:go')

  test('a deep link is served from the SPA fallback with the overlay injected', async ({
    page,
  }) => {
    // Signed in first: since 3.8 every page of the site is behind the gate.
    await signInAs(page)
    // No client-side navigation first: this is a cold request for a route the
    // static bundle has no file for, so it can only work if the Go server
    // falls back to index.html and Caddy rewrites that response.
    await page.goto('/pricing')

    await expect(page.locator('#pricing-title')).toBeVisible()
    await expect(page).toHaveURL(/\/pricing$/)

    // The overlay is mounted, which proves the injected script came from the
    // fallback index.html and not from the app itself (the app ships no c11n
    // code).
    await expect(page.locator('#c11n-root')).toBeAttached()
    await expect(page.locator('.c11n-toolbar')).toBeVisible()
  })

  test('the same-origin Go API answers through the proxy', async ({ page }) => {
    await signInAs(page)

    // The home view fetches /api/ping; "api: go" means the browser reached
    // the Go API on the same origin via Caddy, not that the page guessed.
    await expect(page.locator('[data-testid=api-ping]')).toHaveText(/api:\s*go/)
  })

  test('a gzip-accepting HTML request is still rewritten', async ({ request }) => {
    // The direct-to-upstream half talks to 127.0.0.1:<GO_PORT>, which exists
    // only in the local stack. In external mode the deployment's upstream is
    // inside the cluster, so only the through-the-proxy half can run.
    test.skip(EXTERNAL, 'the upstream port is not reachable in external mode')
    // Caddy sends `header_up Accept-Encoding identity` upstream precisely
    // because a compressed body would make the `</head>` replace silently do
    // nothing. The fixture gzips whenever it is asked to, so this request
    // fails (no overlay tag) if that header ever stops being sent.
    const upstream = await request.get(`${goUpstream}/`, {
      headers: { accept: 'text/html', 'accept-encoding': 'gzip' },
    })
    expect(upstream.headers()['content-encoding']).toBe('gzip')

    // Through the proxy a session is required now, so the gzip behaviour is
    // checked with one.
    const cookie = await sessionCookie((await createUser()).email)
    const res = await request.get('/', {
      headers: { accept: 'text/html', 'accept-encoding': 'gzip', cookie },
    })
    expect(res.status()).toBe(200)
    expect(await res.text()).toContain(overlayTag)
    // ...and the proxy handed the client a plaintext body to begin with.
    expect(res.headers()['content-encoding']).toBeUndefined()
  })

  test('a missing asset 404s through the proxy instead of returning HTML', async ({
    request,
  }) => {
    const cookie = await sessionCookie((await createUser()).email)
    // The Go server must not answer asset paths with index.html: a module
    // answered with HTML fails in a way that looks like a proxy bug.
    const res = await request.get('/assets/definitely-missing.js', {
      headers: { accept: '*/*', cookie },
    })
    expect(res.status()).toBe(404)
  })
})

test.describe('vite dev topology', () => {
  test.skip(fixture !== 'vite', 'vite fixture only; run npm run e2e:vite')

  test('the HMR websocket connects through the proxy', async ({ page }) => {
    const messages: string[] = []
    page.on('console', (msg) => messages.push(msg.text()))

    // The listener goes on first: signInAs is already a full page load of /.
    await signInAs(page)
    await page.goto('/')

    // Vite's client logs "[vite] connected." on a working websocket. Waiting
    // for it positively avoids passing this spec on a page where the client
    // never got far enough to try.
    await expect
      .poll(() => messages.filter((m) => m.includes('[vite] connected.')).length, {
        timeout: 15_000,
      })
      .toBeGreaterThan(0)

    expect(messages.filter((m) => m.includes('failed to connect to websocket'))).toEqual([])
  })
})
