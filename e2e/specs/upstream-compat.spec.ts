import { expect, test, type Browser, type ConsoleMessage, type Page } from '@playwright/test'
import { fixtureName, listComments, resetData, signInAs, upstreamUrl } from '../fixtures'

/**
 * Upstream compatibility probe: the REAL dogfood app behind the proxy (ADR 0009).
 *
 * sasser-studios' `frontend/` is a Vue 3 + PrimeVue + vue-router (history mode)
 * app served by its own vite dev server, and the stack proxies it on :15175
 * with `C11N_UPSTREAM_TLS=insecure`. The app's own login (Zitadel OIDC) is out
 * of scope: its router guard is off upstream today, so pages render without it.
 * c11n's session gate still sits in front of every page, which is why every
 * test signs in first.
 *
 * Each check compares the proxy against the same route loaded DIRECTLY on the
 * upstream (`https://127.0.0.1:15175`, self-signed cert), so a console error
 * that is the app's own doing is not blamed on the proxy — and vice versa.
 *
 * A failing check is a FINDING, not something to fix here: it is committed as
 * `test.fail()` with the symptom and the evidence in the annotation/comment,
 * the way Task 1.5 recorded the Phase 2 overlay bugs. Fixes belong to Task 4.3.
 */
const fixture = fixtureName()
const UPSTREAM = upstreamUrl()
const REVIEW_ORIGIN = new URL(process.env.C11N_E2E_BASE_URL ?? 'http://127.0.0.1:18080').origin

/**
 * A user id that exists in the pinned app's fixtures:
 * frontend/src/services/api/mocks/mockData.json, `users[2]._id` (Priya Sharma).
 * Hard-coded on purpose — the pin is what makes it stable.
 */
const MEMBER_ID = '64b000000000000000000003'

const ROUTES = [
  { path: '/today', ready: '.today-page' },
  { path: '/schedule', ready: '.schedule-page' },
  { path: '/members', ready: 'table.members-table' },
  { path: `/members/${MEMBER_ID}`, ready: '.member-detail' },
  { path: '/packages', ready: 'h1.title' },
] as const

/**
 * The sidebar's secondary nav (Layout.vue: `nav[aria-label="Admin secondary"]`),
 * which is a PrimeVue TabList of RouterLinks. Located by role+name rather than
 * by `a.link:text-is(...)`: PrimeVue wraps each link in a `<button role="tab">`
 * and the text match on the compound selector resolves to nothing.
 */
function navLink(page: Page, label: string) {
  return page.locator('nav[aria-label="Admin secondary"]').getByRole('link', { name: label, exact: true })
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Origins differ between the two loads (proxy :18080, upstream :15175) and the
 * vite HMR URL carries a token query, so error text is normalized before the
 * sets are compared: same message + same route must compare equal.
 */
const ORIGIN_RE = /\b(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/g

function normalize(text: string): string {
  return text
    .replace(ORIGIN_RE, '<origin>')
    .replace(/([?&])token=[^&\s]*/g, '$1token=<redacted>')
}

interface ErrorSet {
  console: string[]
  pageerror: string[]
}

/**
 * A live collector over one page. `clear()` opens a new observation window and
 * `snapshot()` freezes the current one, so a later phase (the sidebar
 * navigation) cannot retroactively join the set that is being compared against
 * a single direct route load.
 */
interface Collected extends ErrorSet {
  clear: () => void
  snapshot: () => ErrorSet
}

/** Everything that counts as "the page complained", as reported by Chromium. */
function collectErrors(page: Page): Collected {
  const out: Collected = {
    console: [],
    pageerror: [],
    clear() {
      out.console.length = 0
      out.pageerror.length = 0
    },
    snapshot() {
      return { console: [...out.console], pageerror: [...out.pageerror] }
    },
  }
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') out.console.push(normalize(msg.text()))
  })
  page.on('pageerror', (err) => {
    out.pageerror.push(normalize(err.message))
  })
  return out
}

function flatten(c: ErrorSet): string[] {
  return [...c.console.map((t) => `console: ${t}`), ...c.pageerror.map((t) => `pageerror: ${t}`)]
}

/**
 * Same-origin (review host) responses >= 400 and aborted requests, plus the
 * overlay's realtime SSE diagnostics.
 *
 * The one thing that is NOT counted as a failure is an `ERR_ABORTED` on the
 * overlay's own EventSource (`/__c11n/pb/api/realtime`): the overlay holds one
 * long-lived stream, and every full page load (the sign-in landing, then each
 * `page.goto`) aborts the previous one. Chromium reports that as a failed
 * request, not as a response, so it would otherwise fail every route for a
 * reason that has nothing to do with the app or the proxy. It is only excused
 * for that URL and only for ERR_ABORTED — a 4xx/5xx on it, or any abort
 * anywhere else, still fails — and the count of established streams (status
 * 200) is logged next to the aborts so a stream that never connected cannot
 * hide behind this exclusion.
 */
const REALTIME_PATH = '/__c11n/pb/api/realtime'

interface Network {
  failed: string[]
  abortedSse: string[]
  realtimeStreams: number
}

function collectNetwork(page: Page): Network {
  const net: Network = { failed: [], abortedSse: [], realtimeStreams: 0 }
  page.on('response', (res) => {
    if (res.url().includes(REALTIME_PATH) && res.status() === 200) net.realtimeStreams++
    if (res.url().startsWith(REVIEW_ORIGIN) && res.status() >= 400) {
      net.failed.push(`${res.status()} ${res.request().method()} ${normalize(res.url())}`)
    }
  })
  page.on('requestfailed', (req) => {
    if (!req.url().startsWith(REVIEW_ORIGIN)) return
    const entry = `requestfailed ${req.method()} ${normalize(req.url())} (${req.failure()?.errorText ?? '?'})`
    if (req.url().includes(REALTIME_PATH) && req.failure()?.errorText === 'net::ERR_ABORTED') {
      net.abortedSse.push(entry)
      return
    }
    net.failed.push(entry)
  })
  return net
}

/** Documents the main frame visited, including client-side router pushes. */
function collectNavigations(page: Page): string[] {
  const out: string[] = []
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) out.push(frame.url())
  })
  return out
}

/**
 * A context on the upstream itself: no proxy, and the vite self-signed cert.
 *
 * The viewport is copied from the proxy-side page: sasser's layout responds to
 * width (the sidebar collapses, tables reflow), and a different window size
 * would make "same console output" a description of two different pages.
 */
async function openDirect(
  browser: Browser,
  source: Page,
  path: string,
  ready: string,
): Promise<{ page: Page; errors: Collected; close: () => Promise<void> }> {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: source.viewportSize(),
  })
  const page = await context.newPage()
  const errors = collectErrors(page)
  await page.goto(`${UPSTREAM}${path}`)
  await expect(page.locator(ready).first()).toBeVisible()
  // Same settle window as the proxy load: enough for the vite client, the
  // devtools client and the app's own post-mount fetches to have spoken.
  await page.waitForTimeout(750)
  return { page, errors, close: () => context.close() }
}

function printSets(label: string, direct: ErrorSet, proxy: ErrorSet): void {
  console.log(
    `\n[compat ${label}] console/pageerror sets` +
      `\n  direct  (${UPSTREAM}): ${JSON.stringify(direct, null, 1)}` +
      `\n  through (${REVIEW_ORIGIN}): ${JSON.stringify(proxy, null, 1)}`,
  )
}

test.describe('sasser upstream compatibility', () => {
  test.skip(fixture !== 'sasser', 'sasser fixture only; run npm run e2e:sasser')

  test.beforeEach(async () => {
    // Comments are global state; every test starts from "no comments".
    await resetData()
  })

  for (const route of ROUTES) {
    test(`${route.path}: overlay injected, no proxy-only errors, stays on the review host`, async ({
      page,
      browser,
    }) => {
      const errors = collectErrors(page)
      const net = collectNetwork(page)
      const navigations = collectNavigations(page)

      await signInAs(page)
      // From here the collector covers exactly ONE route load: the sign-in
      // landing is not the route under test and has no counterpart on the
      // direct side, so keeping it would compare unlike things.
      errors.clear()

      await page.goto(route.path)
      await expect(page.locator(route.ready).first()).toBeVisible()

      // (a) the overlay is mounted on the real app's page
      await expect(page.locator('#c11n-root')).toBeAttached()
      await expect(page.locator('.c11n-toolbar')).toBeVisible()

      // (c) still the review host, not the upstream
      expect(new URL(page.url()).origin, `after loading ${route.path}`).toBe(REVIEW_ORIGIN)

      // Settle, freeze the proxy's error set for THIS route load, then read the
      // same route straight off the upstream. Freezing before the sidebar
      // click below is what makes (b) like-for-like: the direct context loads
      // one route, so the proxy set must be one route load too.
      await page.waitForTimeout(750)
      const proxyRoute = errors.snapshot()
      const direct = await openDirect(browser, page, route.path, route.ready)
      let routeDirect: string[] = []
      try {
        printSets(`${route.path} (route load)`, direct.errors, proxyRoute)

        // (b) no console error / pageerror through the proxy that the app does
        // not already produce when loaded directly.
        routeDirect = flatten(direct.errors)
        const extras = flatten(proxyRoute).filter((entry) => !routeDirect.includes(entry))
        expect(extras, `errors only the proxy introduces on ${route.path}`).toEqual([])
      } finally {
        await direct.close()
      }

      // ...and after one in-app sidebar navigation (vue-router history push:
      // no server round trip is involved, which is the point). Its console
      // output is collected separately and compared against a direct load of
      // the TARGET route, so it is neither blamed on nor excused by the route
      // load above.
      errors.clear()
      const target = route.path === '/packages' ? 'Today' : 'Packages'
      const targetPath = route.path === '/packages' ? '/today' : '/packages'
      const targetReady = ROUTES.find((r) => r.path === targetPath)!.ready
      await navLink(page, target).click()
      await expect(page).toHaveURL(new RegExp(`${targetPath}$`))
      expect(new URL(page.url()).origin, `after clicking ${target}`).toBe(REVIEW_ORIGIN)
      await page.waitForTimeout(750)

      const proxyNav = errors.snapshot()
      const directNav = await openDirect(browser, page, targetPath, targetReady)
      try {
        printSets(`${route.path} -> ${targetPath} (in-app navigation)`, directNav.errors, proxyNav)
        const baseline = [...flatten(directNav.errors), ...routeDirect]
        const navExtras = flatten(proxyNav).filter((entry) => !baseline.includes(entry))
        expect(navExtras, `errors only the proxy introduces navigating to ${targetPath}`).toEqual([])
      } finally {
        await directNav.close()
      }

      // (d) no failed same-origin request through the proxy. The overlay's own
      // traffic is same-origin too (/__c11n/…), so nothing is excluded beyond
      // the documented SSE abort above: a 4xx there would be a real finding.
      console.log(
        `[compat ${route.path}] overlay realtime streams: ${net.realtimeStreams} established, ` +
          `${net.abortedSse.length} aborted by navigation`,
      )
      // Every document load of the review host opens the overlay's EventSource
      // (the sign-in landing, then page.goto), so by now at least one stream
      // must have been ESTABLISHED (a 200). Asserted — not just printed — so
      // the ERR_ABORTED exclusion above cannot hide a stream that never
      // connected: a route where the SSE path is broken must fail here.
      expect(net.realtimeStreams, `overlay realtime streams established on ${route.path}`).toBeGreaterThan(0)
      expect(net.failed, `failed same-origin requests on ${route.path}`).toEqual([])

      // (e) the app's login is out of scope (ADR 0009): nothing may navigate to
      // Zitadel, /login or /auth/callback.
      const authVisits = navigations.filter((url) => /zitadel|\/login(?:[?#]|$)|\/auth\/callback/i.test(url))
      expect(authVisits, `auth navigations on ${route.path}`).toEqual([])
    })
  }

  test('the HMR websocket connects through the proxy', async ({ page }) => {
    const consoleText: string[] = []
    const sockets: string[] = []
    page.on('console', (msg) => consoleText.push(msg.text()))
    page.on('websocket', (ws) => sockets.push(ws.url()))

    await signInAs(page)
    await page.goto('/today')
    await expect(page.locator('.today-page')).toBeVisible()

    // Vite's client logs "[vite] connected." only after its socket is up, so
    // this waits on a positive signal instead of on the absence of a failure —
    // a page that never got far enough to try cannot pass this.
    await expect
      .poll(() => consoleText.filter((m) => m.includes('[vite] connected.')).length, {
        timeout: 15_000,
      })
      .toBeGreaterThan(0)

    console.log(`\n[compat hmr] websockets opened on the review host: ${JSON.stringify(sockets)}`)
    // The socket must be to the review host (Caddy), not the upstream port:
    // that is what proves the proxy upgrades the connection.
    expect(sockets.some((u) => u.startsWith(`ws://127.0.0.1:${new URL(REVIEW_ORIGIN).port}`))).toBe(true)
    expect(consoleText.filter((m) => m.includes('failed to connect to websocket'))).toEqual([])
  })

  test('a comment round trip anchors to a member row and survives a reload', async ({ page }) => {
    await signInAs(page)
    await page.goto('/members')
    const table = page.locator('table.members-table')
    await expect(table).toBeVisible()

    // sasser's members view is a plain <table> (not a PrimeVue DataTable as the
    // plan assumed): each row's first cell is a RouterLink to the member. Pick a
    // non-link cell, so the anchor is the row's own cell — clicking the link
    // would navigate.
    const row = table.locator('tbody tr').first()
    const cell = row.locator('td').nth(2) // "Remaining"
    await expect(cell).toBeVisible()

    await page.locator('.c11n-mode-toggle').click()
    await cell.click()
    await expect(page.locator('.c11n-composer textarea')).toBeVisible()
    await page.locator('.c11n-composer textarea').fill('compat: pinned to a member row')
    await page.locator('.c11n-composer-save').click()
    await expect(page.locator('.c11n-composer')).toHaveCount(0)

    // Stored through the proxy, on the app's own path.
    await expect
      .poll(async () => (await listComments()).map((c) => `${c.path} ${c.body}`))
      .toEqual([`/members compat: pinned to a member row`])

    await page.reload()
    await expect(table).toBeVisible()
    const pin = page.locator('.c11n-pin')
    await expect(pin).toHaveCount(1)
    await expect(pin).toBeVisible()

    // Anchored to the same row after a cold load: inside the pin's horizontal
    // reach of the cell and overlapping its vertical band (the B3 geometry
    // check, applied to a real app's table).
    const pinBox = await pin.boundingBox()
    const anchorBox = await cell.boundingBox()
    expect(pinBox).not.toBeNull()
    expect(anchorBox).not.toBeNull()
    expect(Math.abs(pinBox!.x - (anchorBox!.x + anchorBox!.width))).toBeLessThanOrEqual(120)
    expect(pinBox!.y).toBeLessThan(anchorBox!.y + anchorBox!.height)
    expect(pinBox!.y + pinBox!.height).toBeGreaterThan(anchorBox!.y)
  })

  test("the overlay's shadow-DOM styles do not leak into the app", async ({ page, browser }) => {
    await signInAs(page)
    await page.goto('/members')
    await expect(page.locator('table.members-table')).toBeVisible()
    await expect(page.locator('.c11n-toolbar')).toBeVisible()

    const direct = await openDirect(browser, page, '/members', 'table.members-table')
    let throughStyles: Record<string, string>
    let directStyles: Record<string, string>
    try {
      const read = (p: Page) =>
        p.evaluate(() => {
          const th = document.querySelector('table.members-table thead th') as HTMLElement | null
          const tag = document.querySelector('table.members-table tbody .p-tag') as HTMLElement | null
          const thStyle = th ? getComputedStyle(th) : null
          const tagStyle = tag ? getComputedStyle(tag) : null
          const row = document.querySelector('table.members-table tbody tr') as HTMLElement | null
          return {
            thFont: thStyle?.fontFamily ?? 'missing',
            thSize: thStyle?.fontSize ?? 'missing',
            thColor: thStyle?.color ?? 'missing',
            thBorder: thStyle?.borderBottomColor ?? 'missing',
            rowHeight: row ? `${Math.round(row.getBoundingClientRect().height)}` : 'missing',
            tagFont: tagStyle?.fontFamily ?? 'missing',
            tagBg: tagStyle?.backgroundColor ?? 'missing',
            tagPadding: tagStyle?.paddingInlineStart ?? 'missing',
          }
        })
      throughStyles = await read(page)
      directStyles = await read(direct.page)
    } finally {
      await direct.close()
    }

    console.log(
      `\n[compat styles] through the proxy: ${JSON.stringify(throughStyles)}` +
        `\n[compat styles] direct:            ${JSON.stringify(directStyles)}`,
    )
    expect(throughStyles).toEqual(directStyles)
  })
})
