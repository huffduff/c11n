<script setup lang="ts">
// Project-wide comment list: slide-in right panel, unresolved/resolved tabs,
// grouped by page path with the current page first. Rows on the current page
// open the thread + flash the anchored element; rows on other pages do a full
// navigation (the proxy serves the SPA on every path, so location.assign is
// an acceptable v1 cross-page jump — no SPA-router integration yet).
import { computed, ref, watch } from 'vue'
import { useCommentsStore } from '../stores/comments'
import { useSessionStore } from '../stores/session'
import { backend } from '../lib/backend'
import { resolveAnchor } from '../lib/anchor'
import type { AnchorMeta } from '../lib/anchor'
import type { CommentRec, Role } from '../lib/types'

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

// ---- Invite (task 3.9, ADR 0006 copy-link MVP) ----------------------------
// owner/team only. The server enforces the same matrix; the UI just avoids
// offering a request the hook will 403. The link is the delivery mechanism in
// the MVP (no SMTP), so it is shown with a Copy button rather than emailed.
const session = useSessionStore()
const inviteEmail = ref('')
const inviteRole = ref<Role>('client')
const inviteLink = ref('')
const inviteError = ref<string | null>(null)
const inviteBusy = ref(false)
const inviteCopied = ref(false)
const linkInput = ref<HTMLInputElement | null>(null)

const canInvite = computed(() => session.me?.role === 'owner' || session.me?.role === 'team')

/**
 * ADR 0008: team may invite clients only; owner may invite team/client/owner.
 * `agent` is nobody's to invite by hand (it is minted by the agent-token route
 * in Phase 7).
 */
const invitableRoles = computed<Role[]>(() =>
  session.me?.role === 'owner' ? ['team', 'client', 'owner'] : ['client'],
)

// A role that is no longer offered must not stay selected (a session changing
// under the panel is unlikely, but the select is not the place to find out).
watch(invitableRoles, (roles) => {
  if (!roles.includes(inviteRole.value)) inviteRole.value = roles[0]
})

async function submitInvite() {
  inviteBusy.value = true
  inviteError.value = null
  inviteLink.value = ''
  inviteCopied.value = false
  try {
    const res = await backend.invite(inviteEmail.value.trim(), inviteRole.value)
    inviteLink.value = res.link
  } catch (err) {
    const status = (err as { status?: number } | null)?.status
    inviteError.value =
      status === 403
        ? 'Your role cannot invite that user.'
        : (err as Error).message || 'Invite failed, please try again'
  } finally {
    inviteBusy.value = false
  }
}

/**
 * Copy with a fallback: the clipboard API needs a secure context and a user
 * gesture, and it is unavailable in some embedded browsers. Selecting the
 * text is the fallback the user can still copy by hand (from a readonly input
 * that also makes the link visible).
 */
async function copyInvite() {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(inviteLink.value)
      inviteCopied.value = true
      return
    }
  } catch {
    // Clipboard blocked or unavailable: fall through to selecting the text.
  }
  linkInput.value?.focus()
  linkInput.value?.select()
  inviteCopied.value = true
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

    <section v-if="canInvite" class="c11n-invite" aria-label="Invite a reviewer">
      <h3 class="c11n-invite-title">Invite</h3>
      <form class="c11n-invite-form" @submit.prevent="submitInvite">
        <input
          v-model="inviteEmail"
          class="c11n-input c11n-invite-email"
          type="email"
          placeholder="Email"
          aria-label="Invitee email"
          autocomplete="off"
          required
          :disabled="inviteBusy"
        />
        <select
          v-model="inviteRole"
          class="c11n-input c11n-invite-role"
          aria-label="Role"
          :disabled="inviteBusy"
        >
          <option v-for="r in invitableRoles" :key="r" :value="r">{{ r }}</option>
        </select>
        <button
          class="c11n-btn c11n-invite-submit"
          type="submit"
          :disabled="inviteBusy || !inviteEmail"
        >
          {{ inviteBusy ? 'Creating…' : 'Create link' }}
        </button>
      </form>
      <p v-if="inviteError" class="c11n-invite-error" role="alert">{{ inviteError }}</p>
      <div v-if="inviteLink" class="c11n-invite-result">
        <input
          ref="linkInput"
          class="c11n-input c11n-invite-link"
          :value="inviteLink"
          readonly
          aria-label="Invite link"
          @focus="($event.target as HTMLInputElement).select()"
        />
        <button class="c11n-btn c11n-invite-copy" type="button" @click="copyInvite">
          {{ inviteCopied ? 'Copied' : 'Copy' }}
        </button>
      </div>
    </section>

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
