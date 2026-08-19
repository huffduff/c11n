import { defineStore } from 'pinia'
import { backend } from '../lib/backend'
import { PROJECT } from '../lib/project'
import { resolveAnchor } from '../lib/anchor'
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
    /** All loaded comments for the current path — resolved AND unresolved. */
    items: [] as CommentRec[],
    currentPath: '',
    mode: 'off' as CommentMode,
    pendingAnchor: null as Anchor | null,
    loading: false,
    error: null as string | null,
    /** Comment whose thread popover is open, if any. */
    activeCommentId: null as string | null,
    /** Per-comment reply cache, filled lazily by loadReplies. */
    replies: new Map<string, ReplyRec[]>(),
    /**
     * Unresolved comments on the current path whose anchors no longer match
     * any element. Refreshed by resolvePins(); consumed by the sidebar
     * ("element not found", Task 12).
     */
    orphans: [] as CommentRec[],
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
    /** Switch page identity and (re)load its comments. */
    async setPath(path: string) {
      this.currentPath = path
      this.loading = true
      this.error = null
      try {
        this.items = await backend.listComments(PROJECT, path)
      } catch {
        this.items = []
        this.error = 'Could not load comments'
      } finally {
        this.loading = false
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

    // Realtime hooks (wired up in Task 12).
    upsertFromRealtime(rec: CommentRec) {
      const i = this.items.findIndex((c) => c.id === rec.id)
      if (i === -1) this.items.push(rec)
      else this.items[i] = rec
    },

    removeFromRealtime(id: string) {
      this.items = this.items.filter((c) => c.id !== id)
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
      const ordered = [...this.unresolvedForCurrentPath].sort((a, b) =>
        a.created < b.created ? -1 : a.created > b.created ? 1 : 0,
      )
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
      try {
        await backend.setResolved(commentId, true)
        const item = this.items.find((c) => c.id === commentId)
        if (item) item.resolved = true
        if (this.activeCommentId === commentId) this.activeCommentId = null
      } catch {
        this.error = 'Could not resolve comment'
      }
    },
  },
})
