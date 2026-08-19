import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { trackElements } from '../src/lib/tracker'

// Manual rAF queue: schedule() calls collect here; flushFrame() simulates one
// animation frame. Lets us assert the dirty-flag dedupe (N triggers → 1 recompute).
let frameQueue: FrameRequestCallback[] = []

function flushFrame() {
  const q = frameQueue
  frameQueue = []
  for (const cb of q) cb(0)
}

/** Let jsdom deliver MutationObserver records (microtask checkpoint). */
function tick() {
  return new Promise((r) => setTimeout(r, 0))
}

describe('trackElements', () => {
  let a: HTMLElement
  let b: HTMLElement
  let cleanups: Array<() => void>

  beforeEach(() => {
    document.body.innerHTML = ''
    frameQueue = []
    cleanups = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frameQueue.push(cb)
      return frameQueue.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    a = document.createElement('div')
    b = document.createElement('p')
    document.body.append(a, b)
  })

  afterEach(async () => {
    for (const stop of cleanups) stop()
    vi.unstubAllGlobals()
    await tick()
  })

  function track(onUpdate: (rects: Map<string, DOMRect>) => void) {
    const targets = new Map<string, Element>([
      ['a', a],
      ['b', b],
    ])
    const stop = trackElements(() => targets, onUpdate)
    cleanups.push(stop)
    return stop
  }

  it('computes rects for all targets on the first frame after start', () => {
    const onUpdate = vi.fn()
    track(onUpdate)

    expect(onUpdate).not.toHaveBeenCalled() // waits for the rAF gate
    flushFrame()

    expect(onUpdate).toHaveBeenCalledTimes(1)
    const rects: Map<string, DOMRect> = onUpdate.mock.calls[0][0]
    expect([...rects.keys()].sort()).toEqual(['a', 'b'])
    expect(typeof rects.get('a')!.top).toBe('number')
    expect(typeof rects.get('b')!.right).toBe('number')
  })

  it('scroll x3 in one frame → exactly one recompute (dirty-flag dedupe)', () => {
    const onUpdate = vi.fn()
    track(onUpdate)
    flushFrame()
    onUpdate.mockClear()

    window.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('scroll'))
    expect(onUpdate).not.toHaveBeenCalled()
    flushFrame()

    expect(onUpdate).toHaveBeenCalledTimes(1)
  })

  it('resize schedules one recompute', () => {
    const onUpdate = vi.fn()
    track(onUpdate)
    flushFrame()
    onUpdate.mockClear()

    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('resize'))
    flushFrame()

    expect(onUpdate).toHaveBeenCalledTimes(1)
  })

  it('DOM mutations schedule one recompute per frame', async () => {
    const onUpdate = vi.fn()
    track(onUpdate)
    flushFrame()
    onUpdate.mockClear()

    document.body.appendChild(document.createElement('span'))
    a.setAttribute('data-x', '1')
    await tick() // observer delivery
    flushFrame()

    expect(onUpdate).toHaveBeenCalledTimes(1)
  })

  it('mixed triggers within one frame still collapse to one recompute', async () => {
    const onUpdate = vi.fn()
    track(onUpdate)
    flushFrame()
    onUpdate.mockClear()

    window.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('resize'))
    document.body.appendChild(document.createElement('i'))
    await tick()
    flushFrame()

    expect(onUpdate).toHaveBeenCalledTimes(1)
  })

  it('cleanup removes listeners and disconnects the observer', async () => {
    const onUpdate = vi.fn()
    const stop = track(onUpdate)
    flushFrame()
    onUpdate.mockClear()

    stop()

    window.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('resize'))
    document.body.appendChild(document.createElement('em'))
    await tick()
    flushFrame()
    flushFrame()

    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('a frame already scheduled at cleanup time does not fire onUpdate', () => {
    const onUpdate = vi.fn()
    const stop = track(onUpdate)
    // initial frame still pending
    stop()
    flushFrame()

    expect(onUpdate).not.toHaveBeenCalled()
  })
})
