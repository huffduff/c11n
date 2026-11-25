# ADR 0004: Vue 3 overlay in a shadow DOM, single IIFE bundle

**Status:** Accepted 2026-08-19 (Tom). Unchanged 2026-11-25, with the
DOM-mutation rule tightened.

## Decision

- `packages/overlay` builds to one `overlay.js` (Vite lib/IIFE) with the
  CSS inlined.
- It mounts into `<div id="c11n-root">` with an open shadow root, so the
  reviewed app's styles can't affect it and its styles can't leak out.
- Anchoring uses `@medv/finder` selectors plus `{tag, text, rect}` metadata
  as a fallback. Anchors that can't be resolved are listed as orphans
  rather than guessed.
- Page identity is the normalized `pathname + sorted query`. SPA navigation
  is detected by wrapping `history.pushState`/`replaceState` and listening
  for `popstate`.

## The reviewed DOM is never mutated

The overlay must not write to the reviewed app's elements. That includes
inline styles, classes and attributes. Hover highlights and the "flash"
effect are positioned rects drawn in the shadow root.

The code currently breaks this rule. The picker's hover outline and the
sidebar's flash both set inline `outline` (assessment, "Doc and code
drift"). Plan Phase 6 fixes it.

## Consequences

- `getBoundingClientRect` drives all geometry, and jsdom can't exercise
  it. Geometry behaviour is verified only by the browser e2e (ADR 0007).
