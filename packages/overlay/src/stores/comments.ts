import { defineStore } from 'pinia'
import { backend } from '../lib/backend'
import { PROJECT } from '../lib/project'
import { resolveAnchor } from '../lib/anchor'
import { useSessionStore } from './session'
import type { Anchor, AnchorMeta } from '../lib/anchor'
import type { CommentRec, ReplyRec } from '../lib/types'

export type CommentMode = 'off' | 'pick'

/** A comment whose anchor resolved to a live element on this page. */
export interface ResolvedPin {
  comment: CommentRec
  el: Element
}

/** Placeholder meta for legacy records that have a selector but no anchorMeta. */
const EMPTY_META: AnchorMeta = { tag: '', text: '', rect: { x: 0, y: 0, width: 0, height: 0 } }

/**
 * Comments for the current page + the comment-mode state machine.
 *
 * Mode lifecycle: `off` → enterPickMode → `pick` → (element clicked)
 * beginCompose(anchor) → composer shows while `pendingAnchor` is set →
 * saveComment exits pick mode; cancelCompose only discards the anchor and
 * stays in `pick` so the user can immediately pick another element.
 */
export const useCommentsStore = defineStore('comments', {
  state: () => ({
    /**
     * All loaded comments. Primarily the current path's list (setPath), but
     * realtime upserts may add cross-path records — every consumer getter
     * filters on currentPath, so never iterate this raw for per-page UI.
     */
    items: [] as CommentRec[],
    currentPath: '',
    mode: 'off' as CommentMode,
    pendingAnchor: null as Anchor | null,
    loading: false,
    error: null as string | null,
    /** Comment whose thread popover is open, if any. */
    activeCommentId: null as string | null,
    /** Monotonic token so stale listComments responses can be discarded. */
    _pathToken: 0,
    /** Same pattern for the project-wide sidebar fetch. */
    _sidebarToken: 0,
    /** Per-comment reply cache, filled lazily by loadReplies. */
    replies: new Map<string, ReplyRec[]>(),
    /**
     * Unresolved comments on the current path whose anchors no longer match
     * any element. Refreshed by resolvePins(); consumed by the sidebar
     * ("element not found", Task 12).
     */
    orphans: [] as CommentRec[],
    /** Sidebar visibility. UI-ish, but one flag doesn't warrant its own store. */
    sidebarOpen: false,
    /** Project-wide comment list (every page), loaded when the sidebar opens. */
    sidebarComments: [] as CommentRec[],
    sidebarLoading: false,
    /** Realtime teardown fn; null when not subscribed (also the re-entry guard). */
    _unsubRealtime: null as (() => void) | null,
  }),

  getters: {
    unresolvedForCurrentPath(state): CommentRec[] {
      return state.items.filter((c) => c.path === state.currentPath && !c.resolved)
    },

    resolvedForCurrentPath(state): CommentRec[] {
      return state.items.filter((c) => c.path === state.currentPath && c.resolved)
    },

    /** Default view: unresolved comments on the current page. */
    forCurrentPath(): CommentRec[] {
      return this.unresolvedForCurrentPath
    },

    unresolvedCount(): number {
      return this.unresolvedForCurrentPath.length
    },
  },

  actions: {
    /**
     * Switch page identity and (re)load its comments.
     *
     * Guards:
     * - request token: out-of-order responses from rapid navigations must
     *   not clobber newer state (slow /a response landing after /b's).
     * - abandons any in-progress compose/thread: their anchors belong to
     *   the page we just left; saving them here would persist a comment on
     *   the wrong path (review issue #2, Task 10).
     */
    async setPath(path: string) {
      if (this.pendingAnchor) this.pendingAnchor = null
      if (this.mode === 'pick') this.mode = 'off'
      this.activeCommentId = null

      const token = ++this._pathToken
      this.currentPath = path
      this.loading = true
      this.error = null
      try {
        const items = await backend.listComments(PROJECT, path)
        if (token !== this._pathToken) return // stale response — ignore
        this.items = items
      } catch {
        if (token !== this._pathToken) return
        this.items = []
        this.error = 'Could not load comments'
      } finally {
        if (token === this._pathToken) this.loading = false
      }
    },

    enterPickMode() {
      this.mode = 'pick'
    },

    exitPickMode() {
      this.mode = 'off'
      this.pendingAnchor = null
    },

    /** An element was picked: hold its anchor while the composer is open. */
    beginCompose(anchor: Anchor) {
      this.pendingAnchor = anchor
    },

    /** Discard the draft but stay in pick mode for another attempt. */
    cancelCompose() {
      this.pendingAnchor = null
    },

    async saveComment(body: string) {
      if (!this.pendingAnchor) return
      this.loading = true
      this.error = null
      try {
        const rec = await backend.createComment({
          project: PROJECT,
          path: this.currentPath,
          selector: this.pendingAnchor.selector,
          anchorMeta: this.pendingAnchor.meta,
          body,
        })
        this.items.push(rec)
        this.pendingAnchor = null
        this.mode = 'off'
      } catch {
        // Keep pendingAnchor so the user can retry without re-picking.
        this.error = 'Could not save comment'
      } finally {
        this.loading = false
      }
    },

    // Realtime hooks (wired by startRealtime, Task 12).
    upsertFromRealtime(rec: CommentRec) {
      const i = this.items.findIndex((c) => c.id === rec.id)
      if (i === -1) this.items.push(rec)
      else this.items[i] = rec
    },

    removeFromRealtime(id: string) {
      this.items = this.items.filter((c) => c.id !== id)
    },

    // ------------------------------------------------------------------
    // Sidebar (Task 12)
    // ------------------------------------------------------------------

    toggleSidebar() {
      this.sidebarOpen = !this.sidebarOpen
    },

    /**
     * Load the project-wide comment list (path omitted → all pages).
     * Same stale-response token pattern as setPath: rapid close/reopen must
     * not let an out-of-order response clobber the newer list.
     */
    async loadSidebar() {
      const token = ++this._sidebarToken
      this.sidebarLoading = true
      try {
        const list = await backend.listComments(PROJECT)
        if (token !== this._sidebarToken) return
        this.sidebarComments = list
      } catch {
        if (token !== this._sidebarToken) return
        this.error = 'Could not load comments'
      } finally {
        if (token === this._sidebarToken) this.sidebarLoading = false
      }
    },

    // ------------------------------------------------------------------
    // Realtime (Task 12)
    // ------------------------------------------------------------------

    /**
     * Subscribe to live comment/reply events for PROJECT. Idempotent: a
     * second call while subscribed is a no-op (`_unsubRealtime` is the guard).
     *
     * Live events never carry `expand.author`, so `authorName` arrives
     * undefined. When the event's author is the signed-in user we backfill
     * the name from the session store (the useSessionStore() call is made
     * inside the action so the store is only instantiated on demand); for
     * other authors the UI falls back to 'author'.
     *
     * The replies stream is project-UNSCOPED (documented backend deviation:
     * replies carry no project field), so reply events are filtered here:
     * only threads already in the replies cache are patched.
     */
    startRealtime() {
      if (this._unsubRealtime) return
      const session = useSessionStore()

      const backfill = <T extends { author: string; authorName?: string }>(rec: T): T => {
        if (rec.authorName === undefined && session.me && rec.author === session.me.id) {
          return { ...rec, authorName: session.me.name }
        }
        return rec
      }

      const upsertSidebar = (rec: CommentRec) => {
        const i = this.sidebarComments.findIndex((c) => c.id === rec.id)
        if (i === -1) this.sidebarComments.push(rec)
        else this.sidebarComments[i] = rec
      }

      const onCommentUpsert = (rec: CommentRec) => {
        const filled = backfill(rec)
        this.upsertFromRealtime(filled)
        upsertSidebar(filled)
      }

      this._unsubRealtime = backend.subscribe(PROJECT, {
        onCommentCreate: onCommentUpsert,
        onCommentUpdate: onCommentUpsert,
        onCommentDelete: (rec) => {
          this.removeFromRealtime(rec.id)
          this.sidebarComments = this.sidebarComments.filter((c) => c.id !== rec.id)
        },
        onReplyCreate: (reply) => {
          const cached = this.replies.get(reply.comment)
          if (!cached) return // unknown thread — unscoped stream, ignore
          // Dedupe: our own reply is already appended by addReply.
          if (!cached.some((r) => r.id === reply.id)) cached.push(backfill(reply))
        },
        onReplyUpdate: (reply) => {
          const cached = this.replies.get(reply.comment)
          if (!cached) return
          const i = cached.findIndex((r) => r.id === reply.id)
          if (i !== -1) cached[i] = backfill(reply)
        },
        onReplyDelete: (reply) => {
          const cached = this.replies.get(reply.comment)
          if (!cached) return
          this.replies.set(
            reply.comment,
            cached.filter((r) => r.id !== reply.id),
          )
        },
      })
    },

    /** Tear down the realtime subscription. Safe to call repeatedly. */
    stopRealtime() {
      this._unsubRealtime?.()
      this._unsubRealtime = null
    },

    /**
     * Resolve every unresolved comment on the current path back to a live
     * element. A METHOD, not a getter: resolveAnchor reads the live DOM, and
     * DOM reads don't belong inside reactive getters (they'd re-run on every
     * access and are invisible to Vue's dependency tracking anyway). PinLayer
     * calls this when items/path change.
     *
     * Ordering is created-asc so pin numbering stays stable. Comments with
     * neither a selector nor anchorMeta can't be located at all and are
     * skipped; ones with anchor data that no longer matches are orphaned
     * (surfaced in the sidebar as "element not found").
     */
    resolvePins(): { pinned: ResolvedPin[]; orphaned: CommentRec[] } {
      const ordered = [...this.unresolvedForCurrentPath].sort((a, b) => {
        if (a.seq !== undefined && b.seq !== undefined) {
          return a.seq - b.seq
        }
        if (a.seq !== undefined) return -1
        if (b.seq !== undefined) return 1
        return a.created < b.created ? -1 : a.created > b.created ? 1 : 0
      })
      const pinned: ResolvedPin[] = []
      const orphaned: CommentRec[] = []
      for (const comment of ordered) {
        if (!comment.selector && !comment.anchorMeta) continue
        const el = resolveAnchor({
          selector: comment.selector,
          meta: comment.anchorMeta ?? EMPTY_META,
        })
        if (el) pinned.push({ comment, el })
        else orphaned.push(comment)
      }
      this.orphans = orphaned
      return { pinned, orphaned }
    },

    // Thread popover state.
    openThread(id: string) {
      this.activeCommentId = id
    },

    closeThread() {
      this.activeCommentId = null
    },

    /** Fetch a thread's replies once; later calls hit the cache. */
    async loadReplies(commentId: string) {
      if (this.replies.has(commentId)) return
      try {
        this.replies.set(commentId, await backend.listReplies(commentId))
      } catch {
        this.error = 'Could not load replies'
      }
    },

    async addReply(commentId: string, body: string) {
      this.loading = true
      this.error = null
      try {
        const rec = await backend.createReply(commentId, body)
        const cached = this.replies.get(commentId)
        if (cached) cached.push(rec)
        else this.replies.set(commentId, [rec])
      } catch {
        this.error = 'Could not save reply'
      } finally {
        this.loading = false
      }
    },

    /** Mark resolved in place — PinLayer drops the pin reactively. */
    async resolve(commentId: string) {
      this.error = null
      this.loading = true // disables the Resolve button; prevents double-fire
      try {
        await backend.setResolved(commentId, true)
        const item = this.items.find((c) => c.id === commentId)
        if (item) item.resolved = true
        if (this.activeCommentId === commentId) this.activeCommentId = null
      } catch {
        this.error = 'Could not resolve comment'
      } finally {
        this.loading = false
      }
    },
  },
})
