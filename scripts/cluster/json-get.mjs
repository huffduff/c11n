#!/usr/bin/env node
// scripts/cluster/json-get.mjs — read one field out of a JSON document.
//
// `closedcloud` prints exactly one JSON document per command and this repo does
// not depend on jq (it is not installed everywhere the scripts run):
//
//   closedcloud build . -t c11n-caddy:v1 > build.json
//   repo=$(node scripts/cluster/json-get.mjs repository < build.json)
//   tag=$(node scripts/cluster/json-get.mjs tag < build.json)
//
// Paths are dot-separated (`error.message`, `registry.host`). Missing paths and
// JSON objects/arrays print an error and exit 1, so `$(...)` in a `set -e`
// script fails loudly instead of passing an empty string to helm.
//
// Usage: node scripts/cluster/json-get.mjs <path> [file]
//   With no file, reads stdin.

import fs from 'node:fs'

const [dotted, file] = process.argv.slice(2)
if (!dotted) {
  console.error('usage: json-get.mjs <dot.path> [file]  (stdin when no file)')
  process.exit(2)
}

let text
try {
  text = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8')
} catch (err) {
  console.error(`json-get: cannot read ${file ?? 'stdin'}: ${err.message}`)
  process.exit(1)
}

let doc
try {
  doc = JSON.parse(text)
} catch (err) {
  // A command that failed before printing JSON usually printed nothing (its
  // progress goes to stderr), so say what we actually got.
  console.error(`json-get: input is not JSON (${err.message}): ${text.slice(0, 200)}`)
  process.exit(1)
}

let value = doc
for (const part of dotted.split('.')) {
  if (value === null || typeof value !== 'object' || !(part in value)) {
    console.error(`json-get: no '${dotted}' in the document`)
    process.exit(1)
  }
  value = value[part]
}

if (value === null || typeof value === 'object') {
  console.error(`json-get: '${dotted}' is ${Array.isArray(value) ? 'an array' : 'an object'}, not a scalar`)
  process.exit(1)
}

process.stdout.write(`${value}\n`)
