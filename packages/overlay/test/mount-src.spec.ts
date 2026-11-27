import { describe, expect, it } from 'vitest'

describe('src/main.ts bootstrap', () => {
  it('mounts exactly one #c11n-root host with an open shadow root', async () => {
    await import('../src/main')

    const hosts = document.querySelectorAll('#c11n-root')
    expect(hosts.length).toBe(1)

    const host = hosts[0] as HTMLElement
    expect(host.shadowRoot).not.toBeNull()
    expect(host.shadowRoot!.querySelector('style')?.textContent).toContain(':host')
    // No toolbar here: the shell renders nothing until /api/c11n/me answers,
    // and this test mounts with no proxy in front of it. The signed-in shell is
    // covered by app.spec.ts with a mocked backend.
    expect(host.shadowRoot!.querySelector('.c11n-toolbar')).toBeNull()
  })
})
