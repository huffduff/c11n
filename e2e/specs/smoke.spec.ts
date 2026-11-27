import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(__dirname, '../..')
const overlayTag = '/__c11n/overlay.js'

/** Same resolution order as scripts/tools-lib.sh: $CADDY_BIN, else .tools/caddy. */
function caddyBin(): string {
  const bin = process.env.CADDY_BIN ?? path.join(repoRoot, '.tools', 'caddy')
  if (!fs.existsSync(bin)) {
    throw new Error(`caddy not found at ${bin}; set CADDY_BIN or run scripts/fetch-tools.sh`)
  }
  return bin
}

test.describe('proxy contract', () => {
  test('injects the overlay into HTML only', async ({ request }) => {
    const html = await request.get('/', { headers: { accept: 'text/html' } })
    expect(html.status()).toBe(200)
    const body = await html.text()
    expect(body).toContain(overlayTag)

    // A JS module the site itself loads: the proxy must not rewrite non-HTML
    // bodies, even when the client sends the catch-all Accept header. Derived
    // from the served HTML so the spec is topology-agnostic — /src/main.js on
    // the vite dev server, /assets/index-<hash>.js on the Go production build.
    const asset = [...body.matchAll(/<script[^>]+src="([^"]+)"/g)]
      .map((m) => m[1])
      .find((src) => !src.includes('/__c11n/'))
    expect(asset, 'the served HTML should reference an app script').toBeTruthy()

    const js = await request.get(asset!, { headers: { accept: '*/*' } })
    expect(js.status()).toBe(200)
    expect(js.headers()['content-type']).toContain('javascript')
    expect(await js.text()).not.toContain(overlayTag)

    // JSON from the proxied PocketBase, same-origin under /__c11n/pb.
    const health = await request.get('/__c11n/pb/api/health', { headers: { accept: '*/*' } })
    expect(health.status()).toBe(200)
    expect(await health.text()).not.toContain(overlayTag)
  })

  test('proxies PocketBase health same-origin', async ({ request, baseURL }) => {
    const res = await request.get('/__c11n/pb/api/health')
    expect(res.status()).toBe(200)
    expect(res.url().startsWith(baseURL!)).toBe(true)
    const body = (await res.json()) as { code?: number; message?: string }
    expect(body.code).toBe(200)
  })

  test('mounts the overlay in an open shadow root', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#c11n-root')).toBeAttached()
    await expect(page.locator('.c11n-signin-chip')).toBeVisible()
    const mode = await page.evaluate(
      () => document.getElementById('c11n-root')?.shadowRoot?.mode ?? null,
    )
    expect(mode).toBe('open')
  })
})

test.describe('Caddyfile env matrix', () => {
  function validate(env: Record<string, string>): void {
    const scratch = fs.mkdtempSync(path.join(repoRoot, '.stack', 'validate-'))
    execFileSync(
      caddyBin(),
      ['validate', '--adapter', 'caddyfile', '--config', 'deploy/Caddyfile'],
      {
        cwd: repoRoot,
        stdio: 'pipe',
        env: {
          ...process.env,
          XDG_DATA_HOME: path.join(scratch, 'data'),
          XDG_CONFIG_HOME: path.join(scratch, 'config'),
          ...env,
        },
      },
    )
  }

  test('defaults (http upstream, tls verify)', () => {
    expect(() => validate({})).not.toThrow()
  })

  test('https upstream with default verify', () => {
    expect(() => validate({ C11N_UPSTREAM: 'https://example.com' })).not.toThrow()
  })

  test('https upstream with opt-in insecure skip-verify', () => {
    const env = {
      C11N_UPSTREAM: 'https://localhost:5173',
      C11N_UPSTREAM_TLS: 'insecure',
    }
    expect(() => validate(env)).not.toThrow()
  })

  test('rejects tls skip-verify for a plain-http upstream', () => {
    // B1 regression: Caddy refuses `tls_insecure_skip_verify` on an http://
    // upstream, so the insecure mode must never leak onto the default path.
    const env = { C11N_UPSTREAM: 'http://x:1', C11N_UPSTREAM_TLS: 'insecure' }
    expect(() => validate(env)).toThrow()
  })
})
