<script setup lang="ts">
// Fixed full-viewport layer rendering one numbered pin per unresolved comment
// whose anchor still resolves on this page. Anchor→element resolution lives
// in the store (resolvePins); live geometry comes from the tracker
// (scroll/resize/DOM-mutation → rAF-throttled rect recompute), so pins stay
// glued to their elements as the page moves.
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

/** Re-resolve anchors and restart geometry tracking against the new targets. */
function refresh() {
  const { pinned: resolved } = store.resolvePins()
  pinned.value = resolved.map((p) => p.comment)
  targets = new Map(resolved.map((p) => [p.comment.id, p.el]))
  stopTracking?.()
  rects.value = new Map()
  stopTracking = trackElements(
    () => targets,
    (next) => {
      rects.value = next
    },
  )
}

// Immediate: first resolution happens during setup, so pins are in the very
// first render (targets are page DOM, not component DOM — safe pre-mount).
// Deep: resolve() flips items[i].resolved in place and the pin must drop.
watch(() => [store.items, store.currentPath], refresh, { deep: true, immediate: true })
onBeforeUnmount(() => stopTracking?.())

function pinStyle(id: string): Record<string, string> {
  const r = rects.value.get(id)
  if (!r) return { display: 'none' } // no rect yet (first frame pending)
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
      :aria-label="`Open comment thread ${i + 1}`"
      @click="store.openThread(comment.id)"
    >
      {{ i + 1 }}
    </button>
  </div>
</template>
