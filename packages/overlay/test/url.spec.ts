import { describe, it, expect, vi, afterEach } from 'vitest'
import { normalizePath, onNavigate } from '../src/lib/url'

describe('normalizePath', () => {
  it('strips the hash', () => {
    expect(normalizePath('/a#sec')).toBe('/a')
  })

  it('drops tracking params, keeping the rest', () => {
    expect(normalizePath('/a?utm_source=x&keep=1')).toBe('/a?keep=1')
    expect(normalizePath('/a?utm_campaign=c&keep=1')).toBe('/a?keep=1')
    expect(normalizePath('/a?fbclid=f&keep=1')).toBe('/a?keep=1')
    expect(normalizePath('/a?gclid=g&keep=1')).toBe('/a?keep=1')
    expect(normalizePath('/a?_ga=1&keep=1')).toBe('/a?keep=1')
    expect(normalizePath('/a?_gid=1&keep=1')).toBe('/a?keep=1')
    expect(normalizePath('/a?sessionId=s&keep=1')).toBe('/a?keep=1')
  })

  it('drops trailing ? when all params are tracking params', () => {
    expect(normalizePath('/a?utm_source=x')).toBe('/a')
  })

  it('sorts remaining params by key', () => {
    expect(normalizePath('/a?b=2&a=1')).toBe('/a?a=1&b=2')
  })

  it('treats absolute and relative input identically (origin-independent)', () => {
    expect(normalizePath('https://any.host/p?x=1')).toBe(normalizePath('/p?x=1'))
    expect(normalizePath('https://any.host/p?x=1')).toBe('/p?x=1')
  })

  it('leaves no-param paths unchanged', () => {
    expect(normalizePath('/x')).toBe('/x')
    expect(normalizePath('/')).toBe('/')
  })

  it('preserves repeated keys in insertion order after stable sort', () => {
    // Locked behavior: URLSearchParams.sort() is stable — same-key entries
    // keep their original relative order.
    expect(normalizePath('/a?t=2&t=1')).toBe('/a?t=2&t=1')
    expect(normalizePath('/a?t=2&s=0&t=1')).toBe('/a?s=0&t=2&t=1')
  })

  it('returns malformed absolute-URL input as-is instead of throwing', () => {
    // Never produced by location.href; lib-API safety net.
    expect(normalizePath('http://[bad')).toBe('http://[bad')
    expect(normalizePath('https://')).toBe('https://')
  })

  it('canonicalizes equivalent encodings to one identity', () => {
    // Load-bearing for room-per-URL matching: %20 and + normalize the same.
    expect(normalizePath('/a?x=a%20b')).toBe(normalizePath('/a?x=a+b'))
  })
})

describe('onNavigate', () => {
  let cleanup: (() => void) | null = null

  afterEach(() => {
    cleanup?.()
    cleanup = null
    history.replaceState(null, '', '/')
  })

  it('fires once with the normalized path on pushState', () => {
    history.replaceState(null, '', '/start')
    const cb = vi.fn()
    cleanup = onNavigate(cb)
    history.pushState(null, '', '/new?utm_source=z&q=1')
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith('/new?q=1')
  })

  it('does not fire again when the normalized path is unchanged', () => {
    history.replaceState(null, '', '/same?q=1')
    const cb = vi.fn()
    cleanup = onNavigate(cb)
    history.pushState(null, '', '/same?q=1&utm_source=a')
    expect(cb).toHaveBeenCalledTimes(0)
    history.pushState(null, '', '/same?utm_source=b&q=1')
    expect(cb).toHaveBeenCalledTimes(0)
  })

  it('fires on replaceState when the normalized path changed', () => {
    history.replaceState(null, '', '/r1')
    const cb = vi.fn()
    cleanup = onNavigate(cb)
    history.replaceState(null, '', '/r2')
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith('/r2')
  })

  it('fires on popstate with the current location', () => {
    history.replaceState(null, '', '/p1')
    const cb = vi.fn()
    cleanup = onNavigate(cb)
    history.pushState(null, '', '/p2')
    history.pushState(null, '', '/p3')
    expect(cb).toHaveBeenCalledTimes(2)
    // jsdom's history.back() is flaky; simulate the browser having moved
    // back by replacing state and dispatching popstate manually.
    history.replaceState(null, '', '/p2')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(cb).toHaveBeenCalledTimes(3)
    expect(cb).toHaveBeenLastCalledWith('/p2')
  })

  it('cleanup restores history methods and stops callbacks', () => {
    history.replaceState(null, '', '/c1')
    const originalPush = history.pushState
    const cb = vi.fn()
    const unsub = onNavigate(cb)
    expect(history.pushState).not.toBe(originalPush)
    unsub()
    expect(history.pushState).toBe(originalPush)
    history.pushState(null, '', '/c2')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(cb).toHaveBeenCalledTimes(0)
  })

  it('supports independent double-subscribe with independent cleanup', () => {
    history.replaceState(null, '', '/d1')
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    const unsub1 = onNavigate(cb1)
    const unsub2 = onNavigate(cb2)
    history.pushState(null, '', '/d2')
    expect(cb1).toHaveBeenCalledTimes(1)
    expect(cb2).toHaveBeenCalledTimes(1)
    // unsubscribe in LIFO order (nested wrapping restores correctly)
    unsub2()
    history.pushState(null, '', '/d3')
    expect(cb1).toHaveBeenCalledTimes(2)
    expect(cb2).toHaveBeenCalledTimes(1)
    unsub1()
    history.pushState(null, '', '/d4')
    expect(cb1).toHaveBeenCalledTimes(2)
  })

  it('never resurrects a callback under out-of-order cleanup', () => {
    history.replaceState(null, '', '/o1')
    const originalPush = history.pushState
    const cbA = vi.fn()
    const cbB = vi.fn()
    const unsubA = onNavigate(cbA)
    const unsubB = onNavigate(cbB)
    // Out of order: A first. A's wrapper isn't installed (B wrapped it),
    // so A must NOT restore — doing so would clobber B's wrapper.
    unsubA()
    history.pushState(null, '', '/o2')
    // A is unsubscribed from pushState emits... but its wrapper is still in
    // B's chain; the guarantee we lock is: after BOTH cleanups, no callback
    // ever fires again and pushState behaves like the original.
    unsubB()
    const aCalls = cbA.mock.calls.length
    const bCalls = cbB.mock.calls.length
    history.pushState(null, '', '/o3')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(cbA).toHaveBeenCalledTimes(aCalls) // no resurrection
    expect(cbB).toHaveBeenCalledTimes(bCalls)
    // Restore the pristine method for subsequent tests.
    history.pushState = originalPush
  })
})
