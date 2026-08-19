/**
 * Thin DOM-geometry layer for the pin system.
 *
 * Deliberately dumb: no diffing, no caching — every trigger recomputes rects
 * for ALL current targets and hands the map to the caller, who decides what
 * to do with it. Keeps geometry concerns out of components and stores.
 */

/**
 * Watch the targets returned by `getTargets` and report their viewport rects.
 *
 * Triggers: window scroll (capture — catches scrolls inside nested
 * containers, passive — never blocks scrolling), window resize, and any DOM
 * change under document.body (one MutationObserver: childList + subtree +
 * attributes). All triggers funnel through a single requestAnimationFrame
 * gate with a dirty flag, so N triggers within one frame collapse into one
 * recompute. An initial recompute is scheduled on start.
 *
 * Returns a cleanup function that removes the listeners, disconnects the
 * observer, and cancels/neutralizes any pending frame.
 */
export function trackElements(
  getTargets: () => Map<string, Element>,
  onUpdate: (rects: Map<string, DOMRect>) => void,
): () => void {
  let dirty = false
  let stopped = false
  let rafId = 0

  // jsdom (tests) has no requestAnimationFrame; fall back to a ~1-frame
  // timeout. Looked up per call so test stubs installed later are honored.
  const raf = (cb: FrameRequestCallback): number =>
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(cb)
      : (setTimeout(() => cb(Date.now()), 16) as unknown as number)

  const caf = (id: number): void => {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
    else clearTimeout(id)
  }

  const recompute = () => {
    const rects = new Map<string, DOMRect>()
    for (const [key, el] of getTargets()) {
      rects.set(key, el.getBoundingClientRect())
    }
    onUpdate(rects)
  }

  const schedule = () => {
    if (dirty || stopped) return
    dirty = true
    rafId = raf(() => {
      dirty = false
      // Guard for environments where cancelAnimationFrame didn't land
      // (or cleanup raced the frame).
      if (stopped) return
      recompute()
    })
  }

  const observer = new MutationObserver(schedule)

  window.addEventListener('scroll', schedule, { capture: true, passive: true })
  window.addEventListener('resize', schedule)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true })

  schedule() // initial rects

  return () => {
    stopped = true
    window.removeEventListener('scroll', schedule, { capture: true })
    window.removeEventListener('resize', schedule)
    observer.disconnect()
    caf(rafId)
  }
}
