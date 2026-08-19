import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const bundlePath = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/overlay.js')

describe('built bundle (dist/overlay.js)', () => {
  // Requires `npm run build` first; skipped when dist is absent so unit runs stay green.
  it.skipIf(!existsSync(bundlePath))('mounts the shadow-DOM host when executed in a document', () => {
    const code = readFileSync(bundlePath, 'utf8')
    expect(code).not.toMatch(/^\s*(import|export)\s/m)
    new Function(code)()

    const host = document.getElementById('c11n-root')
    expect(host).not.toBeNull()
    expect(host!.shadowRoot).not.toBeNull()
    expect(host!.shadowRoot!.querySelector('style')?.textContent).toContain('.c11n-toolbar')
    expect(host!.shadowRoot!.querySelector('.c11n-toolbar')?.textContent).toContain('c11n')
  })
})
