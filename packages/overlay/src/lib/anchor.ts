import { finder } from '@medv/finder'

const HOST_ID = 'c11n-root'
const HOST_SELECTOR = `#${HOST_ID}`

export interface AnchorMeta {
  tag: string
  text: string
  rect: { x: number; y: number; width: number; height: number }
}

export interface Anchor {
  selector: string
  meta: AnchorMeta
}

function insideHost(el: Element): boolean {
  return el.closest(HOST_SELECTOR) !== null
}

/**
 * Build a durable anchor for an element: a CSS selector (via @medv/finder)
 * plus enough metadata (tag + text prefix) to re-locate it after DOM shifts.
 *
 * Throws if the element lives inside the overlay's own host (#c11n-root) —
 * callers are expected to filter such elements out first; this is a safety net.
 */
export function createAnchor(el: Element): Anchor {
  if (insideHost(el)) {
    throw new Error('createAnchor: element is inside the overlay host (#c11n-root)')
  }
  const selector = finder(el, { root: document.body })
  const rect = el.getBoundingClientRect()
  return {
    selector,
    meta: {
      tag: el.tagName.toLowerCase(),
      text: (el.textContent ?? '').trim().slice(0, 80),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    },
  }
}

/**
 * Resolve an anchor back to a live element. Ladder:
 *  1. querySelector(anchor.selector) — accepted unless inside #c11n-root.
 *     An invalid/stale selector string throws in querySelector; we catch and
 *     fall through instead of crashing.
 *  2. Text fallback (only when meta.text is non-empty): among elements
 *     matching meta.tag (excluding the overlay host), those whose trimmed
 *     textContent starts with meta.text. Exactly one match → that element;
 *     zero or 2+ → null. Ambiguity must not guess — an orphaned pin is
 *     surfaced in the sidebar instead of landing on the wrong element.
 */
export function resolveAnchor(anchor: Anchor): Element | null {
  let direct: Element | null = null
  try {
    direct = document.querySelector(anchor.selector)
  } catch {
    // Invalid selector (e.g. from a future/foreign version) — fall through.
  }
  if (direct && !insideHost(direct)) return direct

  const prefix = anchor.meta.text
  if (!prefix) return null

  let matched: NodeListOf<Element>
  try {
    matched = document.querySelectorAll(anchor.meta.tag)
  } catch {
    // Corrupted/foreign meta.tag — same crash-safety contract as above.
    return null
  }
  const candidates = Array.from(matched).filter(
    (el) => !insideHost(el) && (el.textContent ?? '').trim().startsWith(prefix),
  )
  return candidates.length === 1 ? candidates[0] : null
}
