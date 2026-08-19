import { describe, expect, it } from 'vitest'

describe('src/main.ts bootstrap', () => {
  it('mounts exactly one #c11n-root host with an open shadow root', async () => {
    await import('../src/main')

    const hosts = document.querySelectorAll('#c11n-root')
    expect(hosts.length).toBe(1)

    const host = hosts[0] as HTMLElement
    expect(host.shadowRoot).not.toBeNull()
    expect(host.shadowRoot!.querySelector('style')?.textContent).toContain(':host')
    expect(host.shadowRoot!.querySelector('.c11n-toolbar')?.textContent).toContain('c11n')
  })
})
