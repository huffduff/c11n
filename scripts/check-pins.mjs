#!/usr/bin/env node
// scripts/check-pins.mjs — S4 supply-chain pins, checked without a browser.
//
// The images are the artifact we ship, but the e2e suite runs the *native*
// binaries fetched by scripts/fetch-tools.sh from scripts/tools.env. Two
// pinned copies of the same fact drift silently: a bumped tools.env with a
// stale Dockerfile means CI proves a different Caddy/PocketBase than the one
// deployed, and a checksum-less zip means a release served to us via a CDN is
// trusted on TLS alone.
//
// This used to be a Playwright spec, which booted the whole stack twice (once
// per fixture) to read five files. It is a plain node script now: no browser,
// no stack, no dependencies — it runs in the overlay CI job in milliseconds.
//
// Usage: node scripts/check-pins.mjs [root]
//   root defaults to the repo containing this script. Passing one lets you run
//   the checks against a scratch copy (the negative test: alter a pin there and
//   expect exit 1).
//
// Exit: 0 all pins agree, 1 on any mismatch (each is printed).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(process.argv[2] ?? path.join(here, '..'))

const failures = []
let checks = 0

/** Assert, collecting failures instead of throwing on the first one. */
function check(ok, what, detail) {
  checks += 1
  if (ok) return
  failures.push(detail ? `${what} (${detail})` : what)
}

function read(rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8')
  } catch (err) {
    failures.push(`cannot read ${rel}: ${err.message}`)
    return ''
  }
}

function envValue(key) {
  const match = read('scripts/tools.env').match(new RegExp(`^${key}=(.*)$`, 'm'))
  if (!match) {
    failures.push(`${key} is not pinned in scripts/tools.env`)
    return ''
  }
  return match[1].trim()
}

/**
 * Lines that are not comments. The Dockerfile comment quotes `sha256sum -c`
 * while explaining the SHELL pipefail, so a naive `includes` would keep
 * passing even if the real RUN step lost its checksum.
 */
function codeLines(text) {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return t !== '' && !t.startsWith('#')
    })
    .join('\n')
}

// ---- deploy/caddy/Dockerfile ----------------------------------------------
{
  const dockerfile = read('deploy/caddy/Dockerfile')
  const caddyVersion = envValue('CADDY_VERSION') // v2.11.4, xcaddy's spelling
  const tag = caddyVersion.replace(/^v/, '') // 2.11.4, Docker's spelling
  const pluginRef = envValue('REPLACE_RESPONSE_REF')

  // The ARG defaults are what a plain `docker build` uses, so they must be the
  // pinned values, not "latest".
  check(new RegExp(`^ARG CADDY_VERSION=${tag}$`, 'm').test(dockerfile), `caddy Dockerfile pins ARG CADDY_VERSION=${tag}`)
  check(new RegExp(`^ARG CADDY_GO_VERSION=${caddyVersion}$`, 'm').test(dockerfile), `caddy Dockerfile pins ARG CADDY_GO_VERSION=${caddyVersion}`)
  check(
    new RegExp(`^ARG REPLACE_RESPONSE_REF=${pluginRef}$`, 'm').test(dockerfile),
    `caddy Dockerfile pins ARG REPLACE_RESPONSE_REF=${pluginRef}`,
  )

  // The base images take the ARG (so a bump is one edit); the ARG default
  // checked above is what pins the actual version.
  check(dockerfile.includes('FROM caddy:${CADDY_VERSION}-builder AS builder'), 'caddy builder stage takes ${CADDY_VERSION}')
  check(/^FROM caddy:\$\{CADDY_VERSION\}$/m.test(dockerfile), 'caddy runtime stage takes ${CADDY_VERSION}')
  check(dockerfile.includes('github.com/caddyserver/replace-response@${REPLACE_RESPONSE_REF}'), 'replace-response is built at the pinned commit')
  // The builder must not resolve a moving tag.
  check(!/FROM caddy:2-builder/.test(dockerfile), 'caddy builder does not use the moving 2-builder tag')
  check(!/FROM caddy:2\b/.test(dockerfile), 'caddy runtime does not use the moving 2 tag')

  // The overlay build stage pins node to .tool-versions, so the bundle in the
  // image is built by the same node the repo and CI use.
  const nodePin = read('.tool-versions').match(/^nodejs (\S+)$/m)?.[1] ?? ''
  check(/^\d+\.\d+\.\d+$/.test(nodePin), `.tool-versions pins an exact nodejs version (got '${nodePin}')`)
  check(new RegExp(`^ARG NODE_VERSION=${nodePin.replace(/\./g, '\\.')}$`, 'm').test(dockerfile), `caddy Dockerfile pins ARG NODE_VERSION=${nodePin}`)
  check(dockerfile.includes('FROM node:${NODE_VERSION}-alpine AS overlay'), 'caddy overlay stage takes ${NODE_VERSION}')
  check(!/FROM node:\d/.test(dockerfile), 'caddy overlay stage does not hardcode a node tag')

  // Everything the runtime stage must carry, and the non-root contract.
  check(dockerfile.includes('COPY --from=overlay /src/packages/overlay/dist /srv/overlay'), 'caddy image bakes the overlay bundle')
  check(dockerfile.includes('COPY packages/signin /srv/signin'), 'caddy image bakes the sign-in page')
  check(dockerfile.includes('COPY deploy/Caddyfile /etc/caddy/Caddyfile'), 'caddy image bakes the Caddyfile')
  check(/^USER 65532:65532$/m.test(dockerfile), 'caddy image runs as uid 65532')
  check(/^EXPOSE 8080$/m.test(dockerfile), 'caddy image listens on 8080 (not a privileged port)')

  // The build context is the repo root, so .dockerignore decides what the
  // COPYs can see. Excluding any of them turns into a broken `docker build`.
  const dockerignore = read('.dockerignore')
  for (const keep of ['packages/overlay', 'packages/signin', 'deploy', 'package.json', 'package-lock.json']) {
    const excluded = dockerignore
      .split('\n')
      .map((line) => line.trim())
      .some((line) => line !== '' && !line.startsWith('#') && !line.startsWith('!') && (line === keep || line === `/${keep}`))
    check(!excluded, `.dockerignore does not exclude ${keep}`)
  }
}

// ---- deploy/pocketbase/Dockerfile -----------------------------------------
{
  const dockerfile = read('deploy/pocketbase/Dockerfile')
  const version = envValue('POCKETBASE_VERSION')
  const amd64 = envValue('POCKETBASE_SHA256_LINUX_AMD64')
  const arm64 = envValue('POCKETBASE_SHA256_LINUX_ARM64')

  check(new RegExp(`^ARG PB_VERSION=${version.replace(/\./g, '\\.')}$`, 'm').test(dockerfile), `pocketbase Dockerfile pins ARG PB_VERSION=${version}`)
  check(dockerfile.includes(`ARG PB_SHA256_AMD64=${amd64}`), 'pocketbase Dockerfile pins the amd64 checksum')
  check(dockerfile.includes(`ARG PB_SHA256_ARM64=${arm64}`), 'pocketbase Dockerfile pins the arm64 checksum')
  // Multi-arch: the release zip name and the checksum both follow TARGETARCH.
  check(/^ARG TARGETARCH\s*$/m.test(dockerfile), 'pocketbase Dockerfile declares TARGETARCH')
  check(dockerfile.includes('linux_${TARGETARCH}.zip'), 'pocketbase downloads the TARGETARCH zip')
  // Non-comment lines only: see codeLines().
  check(codeLines(dockerfile).includes('sha256sum -c'), 'pocketbase verifies the download against the checksum (not just in a comment)')
  // alpine must be a patch tag: `3.20` is re-pointed on every patch release.
  check(/^FROM alpine:\d+\.\d+\.\d+$/m.test(dockerfile), 'pocketbase base image is a patch tag')
  // Non-root contract: numeric uid, a pre-created data dir, and the volume
  // path the chart mounts.
  check(/^USER 65532:65532$/m.test(dockerfile), 'pocketbase image runs as uid 65532')
  // Ownership is established where the bytes land, not by a later `chown -R`
  // that a COPY would undo: the binary, migrations and hooks are COPYd with
  // --chown, and the one writable directory is chowned explicitly.
  check(
    /^COPY --from=fetch --chown=65532:65532 \/out\/pocketbase \/pb\/pocketbase$/m.test(dockerfile),
    'pocketbase binary is COPYd with --chown=65532',
  )
  check(
    /^COPY --chown=65532:65532 pb_migrations \/pb\/pb_migrations$/m.test(dockerfile),
    'pocketbase migrations are COPYd with --chown=65532',
  )
  check(
    /^COPY --chown=65532:65532 pb_hooks \/pb\/pb_hooks$/m.test(dockerfile),
    'pocketbase hooks are COPYd with --chown=65532',
  )
  check(codeLines(dockerfile).includes('chown 65532:65532 /pb/pb_data'), 'pocketbase owns the data dir')
  // unzip is a download-stage tool only: it does not ship. (wget is busybox's,
  // so the runbook's `kubectl exec … -- wget` still works in the runtime image.)
  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('FROM alpine:'))
  check(!/apk add[^\n]*unzip/.test(runtimeStage), 'unzip is not installed in the runtime stage')
  check(dockerfile.includes('--dir=/pb/pb_data'), 'pocketbase stores data at /pb/pb_data')
  check(/^EXPOSE 8090$/m.test(dockerfile), 'pocketbase exposes 8090')
}

// ---- scripts/tools.env -----------------------------------------------------
{
  const amd64 = envValue('POCKETBASE_SHA256_LINUX_AMD64')
  const arm64 = envValue('POCKETBASE_SHA256_LINUX_ARM64')
  for (const [arch, sum] of [
    ['amd64', amd64],
    ['arm64', arm64],
  ]) {
    check(/^[0-9a-f]{64}$/.test(sum), `tools.env ${arch} checksum is a sha256`)
  }
  check(arm64 !== amd64, 'tools.env arm64 checksum differs from amd64')
}

// ---- packages/overlay/package.json ---------------------------------------
{
  let pkg
  try {
    pkg = JSON.parse(read('packages/overlay/package.json'))
  } catch (err) {
    failures.push(`packages/overlay/package.json is not JSON: ${err.message}`)
  }
  if (pkg) {
    const dep = pkg.dependencies?.pocketbase
    // A range ("^0.27.3") is not a pin: `npm ci` would take whatever satisfies it.
    check(/^\d+\.\d+\.\d+$/.test(String(dep)), `overlay SDK is an exact version (got ${dep})`)
    // The js-sdk CHANGELOG: 0.27.x adds the PocketBase 0.39 API surface
    // (`pb.sql.run`); 0.28.0 starts targeting 0.40 (`pb.logs.truncate`).
    const server = envValue('POCKETBASE_VERSION')
    check(server.startsWith('0.39.'), `the pinned server is 0.39.x (got ${server})`)
    check(dep === '0.27.3', `overlay SDK is 0.27.3 (got ${dep})`)
  }
}

if (failures.length > 0) {
  console.error(`check-pins: ${failures.length} of ${checks} checks failed (root: ${root})`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`check-pins: ${checks} checks passed (root: ${root})`)
