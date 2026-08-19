/**
 * URL normalization + SPA navigation hook.
 *
 * Paths are identity here, not origins — the overlay runs behind a proxy,
 * so only `pathname + search` matters.
 */

/** Query params that never contribute to page identity. */
const TRACKING_PARAMS = new Set(['_ga', '_gid', 'sessionId', 'fbclid', 'gclid'])

function isTrackingParam(key: string): boolean {
  return key.startsWith('utm_') || TRACKING_PARAMS.has(key)
}

/**
 * Normalize a full href or path+query to `pathname + search`:
 * hash stripped, tracking params dropped, remaining params sorted by key.
 *
 * Repeated keys: `URLSearchParams.sort()` is stable, so entries sharing a
 * key keep their original relative order (e.g. `?t=2&t=1` stays `t=2&t=1`).
 * Empty search yields no trailing `?`.
 */
export function normalizePath(href: string): string {
  let url: URL
  try {
    // The base makes relative input parseable; the origin is discarded anyway.
    url = new URL(href, 'http://x')
  } catch {
    // Malformed absolute-URL-shaped input ('http://[bad', 'https://').
    // Never produced by location.href; degrade to the raw input as identity
    // rather than throwing inside the overlay.
    return href
  }
  const params = new URLSearchParams(url.search)
  for (const key of [...new Set(params.keys())]) {
    if (isTrackingParam(key)) params.delete(key)
  }
  params.sort()
  const search = params.toString()
  return search ? `${url.pathname}?${search}` : url.pathname
}

/**
 * Fire `cb` with `normalizePath(location.href)` whenever the SPA navigates
 * (pushState / replaceState / popstate), but only when the normalized path
 * actually changed since the last emit.
 *
 * Keeps no module-global state: each call wraps the *current* history
 * methods. The returned cleanup restores what it saved only when its own
 * wrapper is still installed — under out-of-order cleanup of nested
 * subscriptions it skips the restore (never resurrects a stale chain) and
 * always removes its popstate listener.
 */
export function onNavigate(cb: (path: string) => void): () => void {
  let last = normalizePath(location.href)
  let active = true

  const emitIfChanged = () => {
    if (!active) return
    const path = normalizePath(location.href)
    if (path !== last) {
      last = path
      cb(path)
    }
  }

  const originalPushState = history.pushState
  const originalReplaceState = history.replaceState

  const wrappedPushState = function (this: History, ...args: Parameters<History['pushState']>) {
    originalPushState.apply(this, args)
    emitIfChanged()
  } as typeof history.pushState

  const wrappedReplaceState = function (this: History, ...args: Parameters<History['replaceState']>) {
    originalReplaceState.apply(this, args)
    emitIfChanged()
  } as typeof history.replaceState

  history.pushState = wrappedPushState
  history.replaceState = wrappedReplaceState

  window.addEventListener('popstate', emitIfChanged)

  return () => {
    // Kill the callback unconditionally — our wrapper may live on inside a
    // later subscriber's chain, where method restoration can't reach it.
    active = false
    // Only restore if our wrapper is still the installed one; otherwise a
    // later subscriber wrapped us and restoring would resurrect our callback
    // in its chain (or clobber theirs).
    if (history.pushState === wrappedPushState) history.pushState = originalPushState
    if (history.replaceState === wrappedReplaceState) history.replaceState = originalReplaceState
    window.removeEventListener('popstate', emitIfChanged)
  }
}
