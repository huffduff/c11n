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
  // The base makes relative input parseable; the origin is discarded anyway.
  const url = new URL(href, 'http://x')
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
 * methods, and the returned cleanup restores exactly what it saved and
 * removes its popstate listener. Nested subscriptions work as long as
 * cleanup happens in LIFO order.
 */
export function onNavigate(cb: (path: string) => void): () => void {
  let last = normalizePath(location.href)

  const emitIfChanged = () => {
    const path = normalizePath(location.href)
    if (path !== last) {
      last = path
      cb(path)
    }
  }

  const originalPushState = history.pushState
  const originalReplaceState = history.replaceState

  history.pushState = function (this: History, ...args) {
    originalPushState.apply(this, args)
    emitIfChanged()
  } as typeof history.pushState

  history.replaceState = function (this: History, ...args) {
    originalReplaceState.apply(this, args)
    emitIfChanged()
  } as typeof history.replaceState

  window.addEventListener('popstate', emitIfChanged)

  return () => {
    history.pushState = originalPushState
    history.replaceState = originalReplaceState
    window.removeEventListener('popstate', emitIfChanged)
  }
}
