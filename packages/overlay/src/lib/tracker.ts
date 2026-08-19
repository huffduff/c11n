/**
 * Thin DOM-geometry layer for the pin system.
 *
 * Deliberately dumb: no diffing, no caching — every trigger recomputes rects
 * for ALL current targets and hands the map to the caller, who decides what
 * to do with it. Keeps geometry concerns out of components and stores.
 */

/** What woke the tracker up (coalesced per animation frame). */
export type TrackCause = 'initial' | 'scroll' | 'resize' | 'mutation'

/**
 * Watch the targets returned by `getTargets` and report their viewport rects.
 *
 * Triggers: window scroll (capture — catches scrolls inside nested
 * containers, passive — never blocks scrolling), window resize, and any DOM
 * change under document.body (one MutationObserver: childList + subtree +
 * attributes). All triggers funnel through a single requestAnimationFrame
 * gate with a dirty flag, so N triggers within one frame collapse into one
 * recompute; their causes are coalesced and passed to `onUpdate` so callers
 * can react differently to mutations vs. plain scrolling.
 *
 * Disconnected targets get NO rect entry: a removed element measures 0×0 at
 * (0,0), which would render UI pinned to the viewport corner. Callers treat
 * a missing rect as "hide" and may re-resolve on mutation causes.
 *
 * Returns a cleanup function that removes the listeners, disconnects the
 * observer, and cancels/neutralizes any pending frame.
 */
export function trackElements(
  getTargets: () => Map<string, Element>,
  onUpdate: (rects: Map<string, DOMRect>, causes: Set<TrackCause>) => void,
): () => void {
  let dirty = false
  let stopped = false
  let rafId = 0
  let pendingCauses = new Set<TrackCause>()

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

  const recompute = (causes: Set<TrackCause>) => {
    const rects = new Map<string, DOMRect>()
    for (const [key, el] of getTargets()) {
      if (!el.isConnected) continue // removed element — no rect, caller hides
      rects.set(key, el.getBoundingClientRect())
    }
    onUpdate(rects, causes)
  }

  const schedule = (cause: TrackCause) => {
    if (stopped) return
    pendingCauses.add(cause)
    if (dirty) return
    dirty = true
    rafId = raf(() => {
      dirty = false
      const causes = pendingCauses
      pendingCauses = new Set()
      // Guard for environments where cancelAnimationFrame didn't land
      // (or cleanup raced the frame).
      if (stopped) return
      recompute(causes)
    })
  }

  const onScroll = () => schedule('scroll')
  const onResize = () => schedule('resize')
  const observer = new MutationObserver(() => schedule('mutation'))

  window.addEventListener('scroll', onScroll, { capture: true, passive: true })
  window.addEventListener('resize', onResize)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true })

  schedule('initial') // initial rects

  return () => {
    stopped = true
    window.removeEventListener('scroll', onScroll, { capture: true })
    window.removeEventListener('resize', onResize)
    observer.disconnect()
    caf(rafId)
  }
}
