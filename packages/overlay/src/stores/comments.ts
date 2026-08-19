import { defineStore } from 'pinia'
import { backend } from '../lib/backend'
import { PROJECT } from '../lib/project'
import type { Anchor } from '../lib/anchor'
import type { CommentRec } from '../lib/types'

export type CommentMode = 'off' | 'pick'

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
  },
})
