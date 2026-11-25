import { describe, it, expect, vi } from 'vitest'
import { goToSignIn, signInUrl } from '../src/lib/signin'

/**
 * The sign-in URL contract shared by the overlay, the session hook and the
 * gate (tasks 3.5 and 3.7). The page only reads `reason`; `next` is preserved
 * for the post-MVP re-request form.
 */
describe('signInUrl', () => {
  it('defaults to the expired reason', () => {
    expect(signInUrl()).toBe('/__c11n/auth/?reason=expired')
  })

  it('carries the reason', () => {
    expect(signInUrl('signed-out')).toBe('/__c11n/auth/?reason=signed-out')
    expect(signInUrl('invalid')).toBe('/__c11n/auth/?reason=invalid')
  })

  it('encodes next as one parameter, so a query in the path cannot escape', () => {
    const url = signInUrl('expired', '/some/page?x=1&y=2')
    expect(url).toBe('/__c11n/auth/?reason=expired&next=%2Fsome%2Fpage%3Fx%3D1%26y%3D2')
    expect(new URL(url, 'http://x').searchParams.get('next')).toBe('/some/page?x=1&y=2')
  })

  it('omits next when there is nothing to return to', () => {
    expect(signInUrl('expired', '')).toBe('/__c11n/auth/?reason=expired')
  })
})

// goToSignIn writes location.assign; jsdom cannot navigate, so location is
// stubbed and the URL is asserted.
describe('goToSignIn', () => {
  it('keeps the current path (and query) as next', () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { pathname: '/pricing', search: '?x=1', assign })

    goToSignIn('expired')

    expect(assign).toHaveBeenCalledWith('/__c11n/auth/?reason=expired&next=%2Fpricing%3Fx%3D1')
    vi.unstubAllGlobals()
  })

  it('lets the caller override next (the backend does, after a 401)', () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { pathname: '/ignored', search: '', assign })

    goToSignIn('signed-out', '/elsewhere')

    expect(assign).toHaveBeenCalledWith('/__c11n/auth/?reason=signed-out&next=%2Felsewhere')
    vi.unstubAllGlobals()
  })
})
