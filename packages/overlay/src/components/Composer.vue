<script setup lang="ts">
// Floating comment composer, shown while the store holds a pendingAnchor.
// Positioned against the picked element (module-level slot in picker.ts —
// element refs stay out of Pinia state) via @floating-ui/dom.
import { onMounted, ref } from 'vue'
import { computePosition, flip, offset, shift } from '@floating-ui/dom'
import { useCommentsStore } from '../stores/comments'
import { getLastPickedElement } from '../lib/picker'

const comments = useCommentsStore()
const body = ref('')
const panel = ref<HTMLElement | null>(null)
const textarea = ref<HTMLTextAreaElement | null>(null)

onMounted(async () => {
  textarea.value?.focus()
  const reference = getLastPickedElement()
  // A disconnected reference measures 0×0 at (0,0) — the composer would pin
  // to the viewport corner. Fall back to the default centered position.
  if (!reference || !reference.isConnected || !panel.value) return
  const { x, y } = await computePosition(reference, panel.value, {
    placement: 'bottom-start',
    strategy: 'fixed',
    middleware: [offset(8), flip(), shift({ padding: 8 })],
  })
  if (panel.value) {
    panel.value.style.left = `${x}px`
    panel.value.style.top = `${y}px`
  }
})

function save() {
  comments.saveComment(body.value)
}
</script>

<template>
  <div ref="panel" class="c11n-composer">
    <textarea
      ref="textarea"
      v-model="body"
      class="c11n-composer-text"
      placeholder="Leave a comment…"
      rows="3"
      :disabled="comments.loading"
    />
    <p v-if="comments.error" class="c11n-composer-error">{{ comments.error }}</p>
    <div class="c11n-composer-actions">
      <button
        class="c11n-btn c11n-btn-ghost c11n-composer-cancel"
        type="button"
        :disabled="comments.loading"
        @click="comments.cancelCompose()"
      >
        Cancel
      </button>
      <button
        class="c11n-btn c11n-composer-save"
        type="button"
        :disabled="comments.loading || !body.trim()"
        @click="save"
      >
        {{ comments.loading ? 'Saving…' : 'Save' }}
      </button>
    </div>
  </div>
</template>
