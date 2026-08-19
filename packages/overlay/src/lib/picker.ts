/**
 * Element-picking interaction layer for comment mode.
 *
 * Deliberately thin: all state decisions live in the comments store; this
 * module only owns raw DOM listeners so the logic above it stays testable.
 *
 * Highlight approach (v1 deviation from the plan): the hovered element gets a
 * temporary inline `outline` whose previous inline value is saved/restored.
 * The plan prefers a positioned overlay rect that never touches the reviewed
 * DOM — TODO(Task 11): reuse the PinLayer rect machinery for hover highlight
 * and drop the inline-style mutation. Same caveat applies to the crosshair
 * cursor (inline `document.body.style.cursor` save/restore).
 */

const HOST_ID = 'c11n-root'

// The most recently picked element, for Composer positioning. Element refs
// don't belong in Pinia state (non-serializable, devtools noise); a
// module-level slot is the simplest correct home for this single value.
let lastPicked: Element | null = null

export function getLastPickedElement(): Element | null {
  return lastPicked
}

export function setLastPickedElement(el: Element | null): void {
  lastPicked = el
}

/** True when the event originated inside the overlay's own host element. */
function insideHost(e: Event): boolean {
  if (typeof e.composedPath === 'function') {
    for (const t of e.composedPath()) {
      if (t instanceof Element && t.id === HOST_ID) return true
    }
    return false
  }
  // Fallback for environments without composedPath.
  const target = e.target
  return target instanceof Element && target.closest(`#${HOST_ID}`) !== null
}

const HIGHLIGHT_OUTLINE = '2px solid #4f6df5'

/**
 * Start element picking: capture-phase listeners on `document` so the
 * reviewed SPA never sees the click (no accidental navigation). Clicks whose
 * composedPath includes the #c11n-root host are ignored — overlay UI stays
 * fully interactive while picking.
 *
 * Returns a cleanup function that removes all listeners and restores any
 * highlight/cursor mutation.
 */
export function startPicking(onPick: (el: Element) => void): () => void {
  const prevCursor = document.body.style.cursor
  document.body.style.cursor = 'crosshair'

  let highlighted: HTMLElement | null = null
  let prevOutline = ''
  let prevOutlineOffset = ''

  const clearHighlight = () => {
    if (!highlighted) return
    highlighted.style.outline = prevOutline
    highlighted.style.outlineOffset = prevOutlineOffset
    highlighted = null
  }

  const onClick = (e: MouseEvent) => {
    if (insideHost(e)) return
    e.preventDefault()
    e.stopPropagation()
    const el = e.target
    if (!(el instanceof Element)) return
    clearHighlight()
    lastPicked = el
    onPick(el)
  }

  const onMouseOver = (e: MouseEvent) => {
    if (insideHost(e)) return
    const el = e.target
    if (!(el instanceof HTMLElement)) return
    clearHighlight()
    highlighted = el
    prevOutline = el.style.outline
    prevOutlineOffset = el.style.outlineOffset
    el.style.outline = HIGHLIGHT_OUTLINE
    el.style.outlineOffset = '1px'
  }

  const onMouseOut = (e: MouseEvent) => {
    if (e.target === highlighted) clearHighlight()
  }

  document.addEventListener('click', onClick, true)
  document.addEventListener('mouseover', onMouseOver, true)
  document.addEventListener('mouseout', onMouseOut, true)

  return () => {
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('mouseover', onMouseOver, true)
    document.removeEventListener('mouseout', onMouseOut, true)
    clearHighlight()
    document.body.style.cursor = prevCursor
  }
}
