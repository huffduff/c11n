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
import type { CommentRec } from '../lib/types'

const store = useCommentsStore()

// Pin order mirrors resolvePins (created asc) → stable numbering.
const pinned = ref<CommentRec[]>([])
const rects = ref(new Map<string, DOMRect>())

// Element refs stay out of reactive state (same rule as picker.ts).
let targets = new Map<string, Element>()
let stopTracking: (() => void) | null = null
let resolving = false

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

/** Full restart: new page/items → resolve + (re)start the tracker. */
function refresh() {
  reresolve()
  if (!stopTracking) {
    stopTracking = trackElements(
      () => targets,
      (next, causes) => {
        // Mutations may have added/removed anchored elements — re-resolve
        // before accepting geometry so pins appear/disappear correctly.
        if (causes.has('mutation')) reresolve()
        rects.value = next
      },
    )
  }
}

// Immediate: first resolution happens during setup, so pins are in the very
// first render (targets are page DOM, not component DOM — safe pre-mount).
// Deep: resolve() flips items[i].resolved in place and the pin must drop.
watch(() => [store.items, store.currentPath], refresh, { deep: true, immediate: true })
onBeforeUnmount(() => {
  stopTracking?.()
  stopTracking = null
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
