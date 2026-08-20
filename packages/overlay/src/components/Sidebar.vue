<script setup lang="ts">
// Project-wide comment list: slide-in right panel, unresolved/resolved tabs,
// grouped by page path with the current page first. Rows on the current page
// open the thread + flash the anchored element; rows on other pages do a full
// navigation (the proxy serves the SPA on every path, so location.assign is
// an acceptable v1 cross-page jump — no SPA-router integration yet).
import { computed, ref } from 'vue'
import { useCommentsStore } from '../stores/comments'
import { resolveAnchor } from '../lib/anchor'
import type { AnchorMeta } from '../lib/anchor'
import type { CommentRec } from '../lib/types'

const EMPTY_META: AnchorMeta = { tag: '', text: '', rect: { x: 0, y: 0, width: 0, height: 0 } }
const FLASH_MS = 1200
const FLASH_OUTLINE = '3px solid #f5a94f'

const store = useCommentsStore()
const tab = ref<'unresolved' | 'resolved'>('unresolved')

const filtered = computed(() =>
  store.sidebarComments.filter((c) => (tab.value === 'resolved' ? c.resolved : !c.resolved)),
)

interface PathGroup {
  path: string
  label: string
  comments: CommentRec[]
}

/** Group by path; the current page leads as 'This page', the rest sort by path. */
const groups = computed<PathGroup[]>(() => {
  const byPath = new Map<string, CommentRec[]>()
  for (const c of filtered.value) {
    const list = byPath.get(c.path)
    if (list) list.push(c)
    else byPath.set(c.path, [c])
  }
  const out: PathGroup[] = []
  const current = byPath.get(store.currentPath)
  if (current) out.push({ path: store.currentPath, label: 'This page', comments: current })
  for (const path of [...byPath.keys()].sort()) {
    if (path === store.currentPath) continue
    out.push({ path, label: path, comments: byPath.get(path)! })
  }
  return out
})

const orphanIds = computed(() => new Set(store.orphans.map((c) => c.id)))

/**
 * Orphans are computed for the CURRENT page only (resolvePins reads this
 * page's DOM), so rows from other paths never get the badge — we can't know
 * whether their anchors resolve without visiting them.
 */
function isOrphan(c: CommentRec): boolean {
  return c.path === store.currentPath && orphanIds.value.has(c.id)
}

function truncate(body: string): string {
  return body.length > 80 ? `${body.slice(0, 79)}…` : body
}

function displayName(name?: string): string {
  return name || 'author'
}

function displayDate(created: string): string {
  const d = new Date(created.replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? created : d.toLocaleDateString()
}

function onRowClick(c: CommentRec) {
  if (c.path === store.currentPath) {
    store.openThread(c.id)
    flash(c)
  } else {
    // Full page load; the overlay re-injects and re-anchors on the new path.
    location.assign(c.path)
  }
}

/**
 * Scroll the anchored element into view and flash it. The element lives in
 * the reviewed page's light DOM where our shadow stylesheet can't reach, so
 * the visible flash is an inline outline save/restore (same pattern as the
 * picker hover highlight); the c11n-flash class is a marker/test hook.
 *
 * Re-flash safety: originals are captured once per element (WeakMap) and the
 * pending restore timer is cancelled on re-entry — a rapid double-click must
 * never capture the flash outline as the "original" and leave the customer's
 * element permanently outlined.
 */
const flashTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()
const flashOriginals = new WeakMap<HTMLElement, { outline: string; offset: string }>()

function flash(c: CommentRec) {
  const el = resolveAnchor({ selector: c.selector, meta: c.anchorMeta ?? EMPTY_META })
  if (!(el instanceof HTMLElement)) return
  el.scrollIntoView?.({ behavior: 'smooth', block: 'center' })

  const pending = flashTimers.get(el)
  if (pending !== undefined) clearTimeout(pending)
  // Only capture originals when no flash is active on this element.
  if (!flashOriginals.has(el)) {
    flashOriginals.set(el, { outline: el.style.outline, offset: el.style.outlineOffset })
  }

  el.classList.add('c11n-flash')
  el.style.outline = FLASH_OUTLINE
  el.style.outlineOffset = '2px'
  flashTimers.set(
    el,
    setTimeout(() => {
      const orig = flashOriginals.get(el)
      el.classList.remove('c11n-flash')
      el.style.outline = orig?.outline ?? ''
      el.style.outlineOffset = orig?.offset ?? ''
      flashTimers.delete(el)
      flashOriginals.delete(el)
    }, FLASH_MS),
  )
}
</script>

<template>
  <aside class="c11n-sidebar" aria-label="Comments">
    <div class="c11n-sidebar-header">
      <span class="c11n-sidebar-title">Comments</span>
      <button
        class="c11n-sidebar-close"
        type="button"
        aria-label="Close comments panel"
        @click="store.toggleSidebar()"
      >
        ×
      </button>
    </div>

    <div class="c11n-sidebar-tabs" role="tablist">
      <button
        class="c11n-sidebar-tab"
        :class="{ 'c11n-tab-on': tab === 'unresolved' }"
        type="button"
        role="tab"
        :aria-selected="tab === 'unresolved'"
        @click="tab = 'unresolved'"
      >
        Unresolved
      </button>
      <button
        class="c11n-sidebar-tab"
        :class="{ 'c11n-tab-on': tab === 'resolved' }"
        type="button"
        role="tab"
        :aria-selected="tab === 'resolved'"
        @click="tab = 'resolved'"
      >
        Resolved
      </button>
    </div>

    <p v-if="store.sidebarLoading" class="c11n-sidebar-loading">Loading…</p>
    <div v-else class="c11n-sidebar-list">
      <p v-if="groups.length === 0" class="c11n-sidebar-empty">
        No {{ tab }} comments yet
      </p>
      <section v-for="g in groups" :key="g.path" class="c11n-sidebar-group">
        <h3 class="c11n-sidebar-group-label">{{ g.label }}</h3>
        <button
          v-for="c in g.comments"
          :key="c.id"
          class="c11n-sidebar-row"
          :class="{ 'c11n-orphan': isOrphan(c) }"
          type="button"
          @click="onRowClick(c)"
        >
          <span class="c11n-sidebar-row-body">
            <span v-if="c.seq" class="c11n-sidebar-row-seq">#{{ c.seq }}</span>
            {{ truncate(c.body) }}
          </span>
          <span class="c11n-sidebar-row-meta">
            <span class="c11n-sidebar-row-author">{{ displayName(c.authorName) }}</span>
            <span class="c11n-sidebar-row-date">{{ displayDate(c.created) }}</span>
            <span v-if="isOrphan(c)" class="c11n-orphan-flag">⚠ element not found</span>
          </span>
        </button>
      </section>
    </div>
  </aside>
</template>
