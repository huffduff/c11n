#!/usr/bin/env node
// scripts/check-chart.mjs — the Helm chart's regression test, with no cluster.
//
// `helm lint` says the templates are well-formed; it does not say what they
// RENDER. Every chart bug we care about is a rendered-object bug: a Service
// that lost its targetPort, a probe that was pointed at a gated route, a PVC
// whose storage class silently disappeared, an env var that stopped being set
// when a values block was refactored. So each values file under
// deploy/helm/c11n/ci/ is rendered and compared byte-for-byte with a committed
// snapshot.
//
// Also proves the required-input guards: a missing upstream.url or owner.email
// must fail the render, with a message that names the value (a chart that
// renders with an empty upstream is a review site that proxies nowhere).
//
// Usage:
//   node scripts/check-chart.mjs            # verify
//   node scripts/check-chart.mjs --update   # rewrite the snapshots
//
// Requires helm on PATH (CI installs the .tool-versions pin). Exit 1 on any
// drift or failed guard.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const chartDir = path.join(repoRoot, 'deploy', 'helm', 'c11n')
const ciDir = path.join(chartDir, 'ci')
const snapshotDir = path.join(ciDir, '__snapshots__')

const update = process.argv.includes('--update')
// Fixed release name and namespace: the snapshot must not depend on who ran it.
const RELEASE = 'c11n'
const NAMESPACE = 'c11n-ci'

const failures = []
function check(ok, what, detail) {
  if (ok) {
    console.log(`  ok   ${what}`)
  } else {
    console.log(`  FAIL ${what}`)
    if (detail) console.log(indent(detail))
    failures.push(what)
  }
}

function indent(text, by = '       ') {
  return text
    .trimEnd()
    .split('\n')
    .map((line) => by + line)
    .join('\n')
}

function helm(args) {
  const res = spawnSync('helm', args, { cwd: repoRoot, encoding: 'utf8', env: process.env })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', error: res.error }
}

/** Minimal line diff: first differing line plus context, for a readable failure. */
function firstDiff(expected, actual) {
  const a = expected.split('\n')
  const b = actual.split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return [
        `first difference at line ${i + 1}:`,
        `- snapshot: ${JSON.stringify(a[i] ?? '<end of file>')}`,
        `+ rendered: ${JSON.stringify(b[i] ?? '<end of file>')}`,
      ].join('\n')
    }
  }
  return 'no textual difference (trailing whitespace?)'
}

const version = helm(['version', '--short'])
if (version.error || version.status !== 0) {
  console.error('check-chart: helm is not on PATH; install the .tool-versions pin (asdf install helm)')
  process.exit(1)
}
console.log(`check-chart: ${version.stdout.trim()}`)

const valueFiles = fs
  .readdirSync(ciDir)
  .filter((f) => f.endsWith('.yaml'))
  .sort()

if (valueFiles.length === 0) {
  console.error(`check-chart: no values files under ${path.relative(repoRoot, ciDir)}`)
  process.exit(1)
}

fs.mkdirSync(snapshotDir, { recursive: true })

for (const file of valueFiles) {
  const valuesPath = path.join(ciDir, file)
  const name = file.replace(/\.yaml$/, '')
  const snapshotPath = path.join(snapshotDir, `${name}.yaml`)
  const label = path.relative(repoRoot, valuesPath)

  const res = helm([
    'template',
    RELEASE,
    chartDir,
    '--namespace',
    NAMESPACE,
    '--values',
    valuesPath,
  ])

  if (res.status !== 0) {
    check(false, `${label} renders`, res.stderr)
    continue
  }

  if (update) {
    fs.writeFileSync(snapshotPath, res.stdout)
    console.log(`  WROTE ${path.relative(repoRoot, snapshotPath)}`)
    continue
  }

  const expected = fs.existsSync(snapshotPath) ? fs.readFileSync(snapshotPath, 'utf8') : null
  if (expected === null) {
    check(false, `${label} has a snapshot`, `missing ${path.relative(repoRoot, snapshotPath)}; run with --update`)
    continue
  }
  check(expected === res.stdout, `${label} matches its snapshot`, firstDiff(expected, res.stdout))
}

// ---- required-input guards --------------------------------------------------
// Each case: what to unset, and the fragment the error must contain (so a
// generic "wrong type" error cannot stand in for a real guard).
const guards = [
  { name: 'missing upstream.url', args: ['--set', 'upstream.url='], expect: 'upstream.url is required' },
  { name: 'missing owner.email', args: ['--set', 'owner.email='], expect: 'owner.email is required' },
  { name: 'missing host', args: ['--set', 'host='], expect: 'host is required' },
  { name: 'existingSecret without secretName', args: ['--set', 'tls.mode=existingSecret', '--set', 'tls.secretName='], expect: 'tls.secretName is required' },
  { name: 'unknown tls.mode', args: ['--set', 'tls.mode=whatever'], expect: 'tls.mode must be' },
  { name: 'insecure upstream.tls on plain http', args: ['--set', 'upstream.url=http://app.internal', '--set', 'upstream.tls=insecure'], expect: 'needs an https:// upstream.url' },
]

const base = path.join(ciDir, 'traefik-certmanager.yaml')
for (const guard of guards) {
  const res = helm(['template', RELEASE, chartDir, '--namespace', NAMESPACE, '--values', base, ...guard.args])
  const failed = res.status !== 0
  const message = `${res.stderr}${res.stdout}`
  check(failed && message.includes(guard.expect), `guard: ${guard.name} fails the render`, failed ? res.stderr : res.stderr.slice(0, 1500) || '<render succeeded>')
}

// ---- CI and local tool pins agree ------------------------------------------
// The chart job installs helm at a version written in the workflow; the repo
// pins it in .tool-versions. Two copies of the same fact drift, so check it.
{
  const toolVersions = fs.readFileSync(path.join(repoRoot, '.tool-versions'), 'utf8')
  const pinned = toolVersions.match(/^helm (\S+)$/m)?.[1] ?? ''
  const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8')
  const ciVersion = workflow.match(/uses: azure\/setup-helm@v\d+\s*\n\s*with:\s*\n\s*version:\s*v?([\d.]+)/)?.[1] ?? ''
  check(pinned !== '' && pinned === ciVersion, `CI installs the helm pinned in .tool-versions (${pinned} vs ${ciVersion || 'none'})`)
}

if (failures.length > 0) {
  console.error(`\ncheck-chart: ${failures.length} failure(s)`)
  for (const f of failures) console.error(`  - ${f}`)
  if (!update) console.error('  (if the render changed on purpose: node scripts/check-chart.mjs --update)')
  process.exit(1)
}
console.log('check-chart: ok')
