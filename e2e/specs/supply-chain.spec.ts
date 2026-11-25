import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

/**
 * S4 — supply-chain pins.
 *
 * The images are the artifact we ship, but the e2e suite runs the *native*
 * binaries fetched by `scripts/fetch-tools.sh` from `scripts/tools.env`. Two
 * pinned copies of the same fact drift silently: a bumped `tools.env` with a
 * stale Dockerfile means CI proves a different Caddy/PocketBase than the one
 * deployed, and a checksum-less zip means a release that is served to us via
 * a CDN is trusted on TLS alone.
 *
 * These are static assertions on purpose (no Docker daemon needed, so they run
 * in the e2e job on every PR); the CI `docker` job is what actually builds.
 */
const repoRoot = path.resolve(__dirname, '..', '..')

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8')
}

function envValue(key: string): string {
  const match = read('scripts/tools.env').match(new RegExp(`^${key}=(.*)$`, 'm'))
  if (!match) throw new Error(`${key} is not pinned in scripts/tools.env`)
  return match[1].trim()
}

test.describe('S4 — image pins match scripts/tools.env', () => {
  test('the caddy image builds the same version and plugin commit as the e2e tool', () => {
    const dockerfile = read('deploy/caddy/Dockerfile')
    const caddyVersion = envValue('CADDY_VERSION') // v2.11.4, xcaddy's spelling
    const tag = caddyVersion.replace(/^v/, '') // 2.11.4, Docker's spelling
    const pluginRef = envValue('REPLACE_RESPONSE_REF')

    // The ARG defaults are what a plain `docker build` uses, so they must be
    // the pinned values, not "latest".
    expect(dockerfile).toMatch(new RegExp(`^ARG CADDY_VERSION=${tag}$`, 'm'))
    expect(dockerfile).toMatch(new RegExp(`^ARG CADDY_GO_VERSION=${caddyVersion}$`, 'm'))
    expect(dockerfile).toMatch(new RegExp(`^ARG REPLACE_RESPONSE_REF=${pluginRef}$`, 'm'))

    // The base images take the ARG (so a bump is one edit); the ARG default
    // checked above is what pins the actual version.
    expect(dockerfile).toContain('FROM caddy:${CADDY_VERSION}-builder AS builder')
    expect(dockerfile).toMatch(/^FROM caddy:\$\{CADDY_VERSION\}$/m)
    expect(dockerfile).toContain('github.com/caddyserver/replace-response@${REPLACE_RESPONSE_REF}')
    // The builder must not resolve a moving tag.
    expect(dockerfile).not.toMatch(/FROM caddy:2-builder/)
    expect(dockerfile).not.toMatch(/FROM caddy:2\b/)
  })

  test('the pocketbase image pins the version, both checksums and the base image tag', () => {
    const dockerfile = read('deploy/pocketbase/Dockerfile')
    const version = envValue('POCKETBASE_VERSION')
    const amd64 = envValue('POCKETBASE_SHA256_LINUX_AMD64')
    const arm64 = envValue('POCKETBASE_SHA256_LINUX_ARM64')

    expect(dockerfile).toMatch(new RegExp(`^ARG PB_VERSION=${version.replace(/\./g, '\\.')}$`, 'm'))
    expect(dockerfile).toContain(`ARG PB_SHA256_AMD64=${amd64}`)
    expect(dockerfile).toContain(`ARG PB_SHA256_ARM64=${arm64}`)
    // Multi-arch: the release zip name and the checksum both follow TARGETARCH.
    expect(dockerfile).toMatch(/^ARG TARGETARCH\s*$/m)
    expect(dockerfile).toContain('linux_${TARGETARCH}.zip')
    expect(dockerfile).toContain('sha256sum -c')
    // alpine must be a patch tag: `3.20` is re-pointed on every patch release.
    expect(dockerfile).toMatch(/^FROM alpine:\d+\.\d+\.\d+$/m)
  })

  test('tools.env carries the arm64 checksum next to the amd64 one', () => {
    const amd64 = envValue('POCKETBASE_SHA256_LINUX_AMD64')
    const arm64 = envValue('POCKETBASE_SHA256_LINUX_ARM64')
    for (const sum of [amd64, arm64]) expect(sum).toMatch(/^[0-9a-f]{64}$/)
    expect(arm64).not.toBe(amd64)
  })

  test('the overlay SDK is an exact version that pairs with the server', () => {
    const pkg = JSON.parse(read('packages/overlay/package.json')) as {
      dependencies: Record<string, string>
    }
    const dep = pkg.dependencies.pocketbase
    // A range ("^0.27.3") is not a pin: `npm ci` would take whatever satisfies it.
    expect(dep).toMatch(/^\d+\.\d+\.\d+$/)
    // The js-sdk CHANGELOG: 0.27.x adds the PocketBase 0.39 API surface
    // (`pb.sql.run`); 0.28.0 starts targeting 0.40 (`pb.logs.truncate`).
    const server = envValue('POCKETBASE_VERSION')
    expect(server.startsWith('0.39.')).toBe(true)
    expect(dep).toBe('0.27.3')
  })
})
