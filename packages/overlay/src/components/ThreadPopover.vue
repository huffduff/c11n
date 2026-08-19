<script setup lang="ts">
// Thread popover for the active comment: body + author + date, replies,
// reply box, resolve. Mounted fresh per thread (App keys it on
// activeCommentId), so onMounted is the whole lifecycle: load replies, then
// position against the anchored element via @floating-ui/dom.
import { computed, onMounted, ref } from 'vue'
import { computePosition, flip, offset, shift } from '@floating-ui/dom'
import { useCommentsStore } from '../stores/comments'
import { resolveAnchor } from '../lib/anchor'
import type { AnchorMeta } from '../lib/anchor'
import type { CommentRec } from '../lib/types'

const EMPTY_META: AnchorMeta = { tag: '', text: '', rect: { x: 0, y: 0, width: 0, height: 0 } }

const store = useCommentsStore()
const card = ref<HTMLElement | null>(null)
const replyBody = ref('')

const comment = computed<CommentRec | null>(
  () => store.items.find((c) => c.id === store.activeCommentId) ?? null,
)
const replies = computed(() =>
  comment.value ? (store.replies.get(comment.value.id) ?? []) : [],
)

onMounted(async () => {
  const c = comment.value
  if (!c) return
  await store.loadReplies(c.id)
  await position(c)
})

async function position(c: CommentRec) {
  if (!card.value) return
  // Re-resolve rather than reaching into PinLayer internals — same ladder,
  // same element. Orphaned threads keep the default (stylesheet) position.
  const reference = resolveAnchor({ selector: c.selector, meta: c.anchorMeta ?? EMPTY_META })
  if (!reference) return
  const { x, y } = await computePosition(reference, card.value, {
    placement: 'bottom-start',
    strategy: 'fixed',
    middleware: [offset(8), flip(), shift({ padding: 8 })],
  })
  if (card.value) {
    card.value.style.left = `${x}px`
    card.value.style.top = `${y}px`
  }
}

function displayName(name?: string): string {
  return name || 'author'
}

function displayDate(created: string): string {
  const d = new Date(created.replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? created : d.toLocaleDateString()
}

async function submitReply() {
  const c = comment.value
  if (!c || !replyBody.value.trim()) return
  await store.addReply(c.id, replyBody.value)
  if (!store.error) replyBody.value = ''
}

function resolveThread() {
  const c = comment.value
  if (c) store.resolve(c.id) // closes the thread on success
}
</script>

<template>
  <div v-if="comment" ref="card" class="c11n-popover">
    <div class="c11n-popover-header">
      <span class="c11n-popover-author">{{ displayName(comment.authorName) }}</span>
      <span class="c11n-popover-date">{{ displayDate(comment.created) }}</span>
      <button
        class="c11n-popover-close"
        type="button"
        aria-label="Close thread"
        @click="store.closeThread()"
      >
        ×
      </button>
    </div>

    <p class="c11n-popover-body">{{ comment.body }}</p>

    <ul v-if="replies.length" class="c11n-popover-replies">
      <li v-for="r in replies" :key="r.id" class="c11n-popover-reply">
        <span class="c11n-popover-author">{{ displayName(r.authorName) }}</span>
        <span class="c11n-popover-reply-body">{{ r.body }}</span>
      </li>
    </ul>

    <textarea
      v-model="replyBody"
      class="c11n-popover-reply-text"
      placeholder="Reply…"
      rows="2"
      :disabled="store.loading"
    />
    <p v-if="store.error" class="c11n-popover-error">{{ store.error }}</p>

    <div class="c11n-popover-actions">
      <button
        class="c11n-btn c11n-btn-ghost c11n-popover-resolve"
        type="button"
        :disabled="store.loading"
        @click="resolveThread"
      >
        Resolve
      </button>
      <button
        class="c11n-btn c11n-reply-submit"
        type="button"
        :disabled="store.loading || !replyBody.trim()"
        @click="submitReply"
      >
        {{ store.loading ? 'Sending…' : 'Reply' }}
      </button>
    </div>
  </div>
</template>
