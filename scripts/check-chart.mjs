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
  // Credentials: each of these renders a Deployment with a secretKeyRef to a
  // key that would not exist, i.e. a pod stuck in CreateContainerConfigError.
  {
    name: 'backup.cron without a bucket',
    args: ['--set-json', 'backup.cron="0 3 * * *"'],
    expect: 'backup.s3.bucket is empty',
  },
  {
    // PocketBase's own settings validation refuses a blank endpoint/region, and
    // a save that fails leaves backups off - so the render refuses first.
    name: 'backup.cron without an endpoint',
    args: [
      '--set-json', 'backup.cron="0 3 * * *"',
      '--set', 'backup.s3.bucket=b', '--set', 'backup.s3.region=r',
      '--set', 'backup.s3.accessKey=a', '--set', 'backup.s3.secretKey=s',
    ],
    expect: 'backup.s3.endpoint is empty',
  },
  {
    name: 'backup.cron without a region',
    args: [
      '--set-json', 'backup.cron="0 3 * * *"',
      '--set', 'backup.s3.bucket=b', '--set', 'backup.s3.endpoint=https://s3.example.com',
      '--set', 'backup.s3.accessKey=a', '--set', 'backup.s3.secretKey=s',
    ],
    expect: 'backup.s3.region is empty',
  },
  {
    name: 'backup.cron without an access key',
    args: [
      '--set-json', 'backup.cron="0 3 * * *"',
      '--set', 'backup.s3.bucket=b', '--set', 'backup.s3.endpoint=https://s3.example.com',
      '--set', 'backup.s3.region=r', '--set', 'backup.s3.secretKey=s',
    ],
    expect: 'backup.s3.accessKey is empty',
  },
  {
    name: 'backup.cron without a secret key',
    args: [
      '--set-json', 'backup.cron="0 3 * * *"',
      '--set', 'backup.s3.bucket=b', '--set', 'backup.s3.endpoint=https://s3.example.com',
      '--set', 'backup.s3.region=r', '--set', 'backup.s3.accessKey=a',
    ],
    expect: 'backup.s3.secretKey is empty',
  },
  { name: 'smtp.enabled without a host', args: ['--set', 'smtp.enabled=true'], expect: 'needs smtp.host' },
  {
    name: 'smtp auth without a password',
    args: ['--set', 'smtp.enabled=true', '--set', 'smtp.host=smtp.example.com', '--set', 'smtp.password='],
    expect: 'needs smtp.password',
  },
  {
    // cert-manager writes one certificate per Secret: the admin Ingress must not
    // point at the review host's.
    name: 'admin Ingress sharing the review TLS Secret',
    args: [
      '--set', 'adminIngress.enabled=true',
      '--set', 'adminIngress.host=admin.review.example.com',
      '--set', 'adminIngress.tls.secretName=review.example.com-tls',
    ],
    expect: 'must not share the review host',
  },
]

const base = path.join(ciDir, 'traefik-certmanager.yaml')
for (const guard of guards) {
  const res = helm(['template', RELEASE, chartDir, '--namespace', NAMESPACE, '--values', base, ...guard.args])
  const failed = res.status !== 0
  const message = `${res.stderr}${res.stdout}`
  check(failed && message.includes(guard.expect), `guard: ${guard.name} fails the render`, failed ? res.stderr : res.stderr.slice(0, 1500) || '<render succeeded>')
}

// ---- invariants a values file must not be able to break ---------------------
// The single-writer rule is the one safety property of this chart that a
// well-meaning `--set` could quietly destroy (two pods, one SQLite file). It is
// hardcoded in the template, and this proves it stays hardcoded: the value is
// not exposed, so Helm ignores it and the StatefulSet still renders 1.
{
  const res = helm([
    'template', RELEASE, chartDir, '--namespace', NAMESPACE, '--values', base,
    '--set', 'pocketbase.replicas=3',
  ])
  const sts = documents(res.stdout).find((doc) => kindOf(doc) === 'StatefulSet') ?? ''
  check(
    res.status === 0 && /^  replicas:\s*1$/m.test(sts),
    'guard: pocketbase.replicas cannot move the StatefulSet off 1',
    res.status !== 0 ? res.stderr : 'the render honoured an override',
  )
}

// The policy is on by default, but the opt-out has to be real: a chart that
// renders a NetworkPolicy no matter what cannot be installed on a CNI that
// does not enforce them (where the object is harmless) or debugged when a
// wrong ingressNamespace is suspected.
{
  const res = helm(['template', RELEASE, chartDir, '--namespace', NAMESPACE, '--values', base, '--set', 'networkPolicy.enabled=false'])
  const count = documents(res.stdout).filter((doc) => kindOf(doc) === 'NetworkPolicy').length
  check(res.status === 0 && count === 0, 'guard: networkPolicy.enabled=false renders no NetworkPolicy', `rendered ${count}`)
}

// ---- rendered objects that must agree with each other -----------------------
// A snapshot says "the render changed"; these say "the render is consistent",
// which is the class of bug a snapshot cannot describe: a Deployment that
// references a Secret nobody rendered, two Ingresses that would fight over one
// certificate, a digest that silently lost to a tag.

function documents(text) {
  // helm puts a `# Source: chart/templates/x.yaml` line at the top of every
  // document; drop comment lines so the checks below see the object itself.
  return text
    .split(/^---$/m)
    .map((doc) =>
      doc
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n')
        .trim(),
    )
    .filter((doc) => doc !== '')
}

function kindOf(doc) {
  return doc.match(/^kind:\s*(\S+)$/m)?.[1] ?? ''
}

function metadataName(doc) {
  return doc.match(/^metadata:\n(?:.*\n)*?\s{2}name:\s*(\S+)$/m)?.[1] ?? ''
}

const renders = new Map()
for (const file of valueFiles) {
  const label = path.relative(repoRoot, path.join(ciDir, file))
  const res = helm(['template', RELEASE, chartDir, '--namespace', NAMESPACE, '--values', path.join(ciDir, file)])
  if (res.status !== 0) {
    check(false, `${label} renders for the consistency checks`, res.stderr)
    continue
  }
  renders.set(label, res.stdout)
}

for (const [label, text] of renders) {
  const docs = documents(text)
  const secrets = docs.filter((doc) => kindOf(doc) === 'Secret')

  // Every secretKeyRef must point at a rendered Secret AND an existing key, or
  // the pod never starts.
  const refs = [...text.matchAll(/secretKeyRef:\s*\n\s*name:\s*(\S+)\s*\n\s*key:\s*(\S+)/g)]
  const missing = []
  for (const [, name, key] of refs) {
    const doc = secrets.find((candidate) => metadataName(candidate) === name)
    if (!doc) {
      missing.push(`Secret ${name} is not rendered`)
    } else if (!new RegExp(`^\\s{2}${key}:\\s*\\S+$`, 'm').test(doc)) {
      missing.push(`Secret ${name} has no ${key}`)
    }
  }
  check(missing.length === 0, `${label}: every secretKeyRef has a Secret and a key`, missing.join('; '))

  // Two Ingresses, one certificate: the names must differ. Only Ingresses that
  // actually terminate TLS have a secretName (tls.mode=none renders none).
  const ingressSecrets = docs
    .filter((doc) => kindOf(doc) === 'Ingress' && /^\s{2}tls:$/m.test(doc))
    .map((doc) => (doc.match(/^\s+secretName:\s*(\S+)$/m)?.[1] ?? '').replace(/"/g, ''))
  if (ingressSecrets.length > 1) {
    check(
      ingressSecrets.every((name) => name !== '') && new Set(ingressSecrets).size === ingressSecrets.length,
      `${label}: the review and admin Ingresses use different TLS Secrets (${ingressSecrets.join(', ')})`,
    )
  }

  // A digest must beat the tag: `<repo>@sha256:<64 hex>`, never `<repo>:<tag>`.
  const digested = [...text.matchAll(/^\s+image:\s*(\S+)$/gm)].map((m) => m[1].replace(/"/g, ''))
  if (label.endsWith('certmanager-admin.yaml')) {
    check(
      digested.length > 0 && digested.every((image) => /@sha256:[0-9a-f]{64}$/.test(image)),
      `${label}: image.digest renders repo@sha256:… (${digested.join(', ')})`,
    )
  }

  // ---- the split layout ----------------------------------------------------
  // caddy is a stateless Deployment; pocketbase is a one-replica StatefulSet
  // that owns the claim. These are the assertions that keep the two from
  // growing back together: a PVC object, a pb-data mount on the proxy, a
  // pocketbase Service that is not ClusterIP, an Ingress pointing at it
  // without the admin opt-in, or a StatefulSet someone can scale off 1.
  const deployments = docs.filter((doc) => kindOf(doc) === 'Deployment')
  const statefulsets = docs.filter((doc) => kindOf(doc) === 'StatefulSet')
  const services = docs.filter((doc) => kindOf(doc) === 'Service')
  const ingresses = docs.filter((doc) => kindOf(doc) === 'Ingress')

  // No pod in this chart may carry a usable API token - on either workload.
  const workloads = [...deployments, ...statefulsets]
  check(
    workloads.length > 0 && workloads.every((doc) => /^\s{6}automountServiceAccountToken:\s*false$/m.test(doc)),
    `${label}: automountServiceAccountToken is false on every workload`,
  )

  check(
    !docs.some((doc) => kindOf(doc) === 'PersistentVolumeClaim'),
    `${label}: no PersistentVolumeClaim object (the StatefulSet's volumeClaimTemplate owns pb_data)`,
  )

  const caddyDeploy = deployments.find((doc) => metadataName(doc).endsWith('-caddy'))
  check(caddyDeploy !== undefined, `${label}: a caddy Deployment exists`)
  if (caddyDeploy) {
    check(
      !/pb-data|persistentVolumeClaim|claimName:/.test(caddyDeploy),
      `${label}: the caddy Deployment mounts no pb_data volume`,
    )
    check(/strategy:\n\s+type: RollingUpdate/m.test(caddyDeploy), `${label}: caddy rolls (RollingUpdate, never Recreate)`)
  }

  const pbSts = statefulsets.find((doc) => metadataName(doc).endsWith('-pocketbase'))
  check(pbSts !== undefined, `${label}: a pocketbase StatefulSet exists`)
  if (pbSts) {
    check(
      /^  replicas:\s*1$/m.test(pbSts),
      `${label}: pocketbase replicas is hardcoded to 1 (SQLite has a single writer)`,
    )
    check(
      /\n  volumeClaimTemplates:/.test(pbSts) && /name: pb-data/.test(pbSts),
      `${label}: pocketbase owns pb_data through volumeClaimTemplates`,
    )
    check(
      /whenDeleted: Retain/.test(pbSts) && /whenScaled: Retain/.test(pbSts),
      `${label}: pb_data is retained when the StatefulSet is deleted or scaled`,
    )
    const govern = pbSts.match(/^  serviceName:\s*(\S+)$/m)?.[1] ?? ''
    const svcNames = services.map((doc) => metadataName(doc))
    check(
      govern !== '' && svcNames.includes(govern) && /clusterIP:\s*None/.test(services.find((doc) => metadataName(doc) === govern) ?? ''),
      `${label}: the StatefulSet's serviceName is a rendered headless Service (${govern || 'none'})`,
    )
  }

  // Service types and Ingress backends must agree. The review Ingress has to
  // reach caddy; the pocketbase Service is internal, and the only Ingress
  // allowed to name it is the admin one (which carries the warning annotation
  // and only renders when adminIngress.enabled).
  const svcTypes = new Map()
  const svcPorts = new Map()
  for (const doc of services) {
    const name = metadataName(doc)
    svcTypes.set(name, doc.match(/^  type:\s*(\S+)$/m)?.[1] ?? '')
    const portsBlock = doc.match(/^  ports:\n((?:\s{4}.*\n)+)/m)?.[1] ?? ''
    svcPorts.set(name, [...portsBlock.matchAll(/- name:\s*(\S+)/g)].map((m) => m[1]))
  }
  const backends = [
    ...text.matchAll(/backend:\n\s+service:\n\s+name:\s*(\S+)\n\s+port:\n\s+name:\s*(\S+)/g),
  ].map((m) => ({ name: m[1], port: m[2] }))
  const unresolved = backends.filter((b) => !svcTypes.has(b.name) || !(svcPorts.get(b.name) ?? []).includes(b.port))
  check(
    backends.length > 0 && unresolved.length === 0,
    `${label}: every Ingress backend is a rendered Service with that port name`,
    unresolved.map((b) => `${b.name}:${b.port}`).join(', '),
  )

  const pbSvc = [...svcTypes.keys()].find((name) => name.endsWith('-pocketbase'))
  check(
    pbSvc !== undefined && svcTypes.get(pbSvc) === 'ClusterIP',
    `${label}: the pocketbase Service is ClusterIP (internal only, never NodePort/LoadBalancer)`,
  )
  const directExposure = ingresses.filter((doc) => /service:\n\s+name:\s*\S*-pocketbase\b/.test(doc))
  check(
    directExposure.every((doc) => /c11n\.io\/warning/.test(doc)),
    `${label}: the pocketbase Service is behind an Ingress only when adminIngress is on`,
  )

  // The NetworkPolicy is ON by default: two objects, each scoped to its own
  // component, and pocketbase opens 8090 to caddy pods and nothing else.
  const policies = docs.filter((doc) => kindOf(doc) === 'NetworkPolicy')
  check(
    policies.length === 2,
    `${label}: NetworkPolicy renders by default (${policies.map(metadataName).join(', ') || 'none'})`,
  )
  const pbPolicy = policies.find((doc) => metadataName(doc).endsWith('-pocketbase')) ?? ''
  const caddyPolicy = policies.find((doc) => metadataName(doc).endsWith('-caddy')) ?? ''
  check(
    /component: pocketbase/.test(pbPolicy) && /port:\s*8090/.test(pbPolicy) && !/port:\s*8080/.test(pbPolicy),
    `${label}: the pocketbase policy admits 8090 only`,
  )
  check(
    /from:\n\s+- podSelector:/.test(pbPolicy) && /component: caddy/.test(pbPolicy),
    `${label}: the pocketbase policy admits caddy pods by component label`,
  )
  check(
    /namespaceSelector:/.test(caddyPolicy) && /port:\s*8080/.test(caddyPolicy) && !/port:\s*8090/.test(caddyPolicy),
    `${label}: the caddy policy admits the ingress controller on 8080 only`,
  )
  check(
    !/policyTypes:\n\s+- Egress/.test(pbPolicy + caddyPolicy),
    `${label}: the policies restrict ingress only (caddy needs an arbitrary upstream, pocketbase an S3 endpoint)`,
  )
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
