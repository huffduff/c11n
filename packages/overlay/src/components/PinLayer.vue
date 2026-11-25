<script setup lang="ts">
// Fixed full-viewport layer rendering one numbered pin per unresolved comment
// whose anchor still resolves on this page. Anchor→element resolution lives
// in the store (resolvePins); live geometry comes from the tracker
// (scroll/resize/DOM-mutation → rAF-throttled rect recompute), so pins stay
// glued to their elements as the page moves.
//
// Re-resolution strategy (review fixes, Task 11):
// - DOM mutations re-run anchor resolution (not just repositioning), so
//   late-rendered elements (SPA hydration, lazy chunks) gain their pins and
//   removed elements orphan cleanly instead of leaving stale pins.
// - Disconnected targets get no rect from the tracker → pin hidden.
import { onBeforeUnmount, ref, watch } from 'vue'
import { useCommentsStore } from '../stores/comments'
import { trackElements } from '../lib/tracker'
import type { ElementTracker, TrackCause } from '../lib/tracker'
import type { CommentRec } from '../lib/types'

const store = useCommentsStore()

// Pin order mirrors resolvePins (created asc) → stable numbering.
const pinned = ref<CommentRec[]>([])
const rects = ref(new Map<string, DOMRect>())

// Element refs stay out of reactive state (same rule as picker.ts).
let targets = new Map<string, Element>()
let tracker: ElementTracker | null = null
let resolving = false
// Set on unmount: a frame scheduled before teardown must not rebuild the
// tracker on a dead component.
let dead = false

/** Cheap, order-insensitive identity of the current target set. */
function targetKey(): string {
  return [...targets.keys()].sort().join('\n')
}

/** Re-run anchor resolution against the live DOM and swap the target set. */
function reresolve() {
  // Our own pin/style writes land in the shadow root (invisible to the
  // light-DOM observer), but guard against indirect recursion anyway.
  if (resolving) return
  resolving = true
  try {
    const { pinned: resolved } = store.resolvePins()
    pinned.value = resolved.map((p) => p.comment)
    targets = new Map(resolved.map((p) => [p.comment.id, p.el]))
  } finally {
    resolving = false
  }
}

/**
 * Tracker callback. The rects it hands over were measured against the target
 * set as it was BEFORE the triggering mutation, so a target that mutation
 * revealed has no rect — and its pin, rendered inside the shadow root, is
 * invisible to the observer that would otherwise schedule another frame. When
 * re-resolving actually changes the set, ask the tracker for one more frame.
 */
function onUpdate(next: Map<string, DOMRect>, causes: Set<TrackCause>) {
  if (dead) return
  // Accept the geometry first: with a synchronous rAF (tests) refresh() below
  // recomputes inside this call, and assigning these older rects afterwards
  // would undo the fresh ones.
  rects.value = next
  if (!causes.has('mutation')) return

  const before = targetKey()
  reresolve()
  // Guarded on the id set, not on the cause: it changes at most once per
  // real mutation, so the extra frame converges instead of looping.
  if (targetKey() !== before) tracker?.refresh()
}

/** Full restart: new page/items → resolve + (re)start/recompute the tracker. */
function refresh() {
  if (dead) return
  reresolve()
  if (!tracker) {
    tracker = trackElements(() => targets, onUpdate)
  } else {
    // Items/path changed but the document may not have: force a recompute
    // for the freshly resolved targets, or pins stay display:none until the
    // next scroll/resize (B3).
    tracker.refresh()
  }
}

// Immediate: first resolution happens during setup, so pins are in the very
// first render (targets are page DOM, not component DOM — safe pre-mount).
// Deep: resolve() flips items[i].resolved in place and the pin must drop.
watch(() => [store.items, store.currentPath], refresh, { deep: true, immediate: true })
onBeforeUnmount(() => {
  dead = true
  tracker?.stop()
  tracker = null
})

function pinStyle(id: string): Record<string, string> {
  const r = rects.value.get(id)
  if (!r) return { display: 'none' } // no rect yet, or target disconnected
  return { left: `${r.right + 4}px`, top: `${r.top - 4}px` }
}
</script>

<template>
  <div class="c11n-pin-layer" aria-hidden="false">
    <button
      v-for="(comment, i) in pinned"
      :key="comment.id"
      class="c11n-pin"
      type="button"
      :style="pinStyle(comment.id)"
      :aria-label="`Open comment thread ${comment.seq ?? i + 1}`"
      @click="store.openThread(comment.id)"
    >
      {{ comment.seq ?? i + 1 }}
    </button>
  </div>
</template>
