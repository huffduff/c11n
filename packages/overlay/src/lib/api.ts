import PocketBase from 'pocketbase'
import type { CommentRec, Me, NewComment, RealtimeHandlers, ReplyRec } from './types'

export type { CommentRec, Me, NewComment, RealtimeHandlers, ReplyRec }

/**
 * Swappable data-access layer for the overlay. The UI only ever talks to
 * this interface; `createPocketBaseBackend` is the v1 implementation.
 */
export interface C11nBackend {
  login(email: string, password: string): Promise<Me>
  logout(): void
  me(): Me | null
  listComments(project: string, path: string): Promise<CommentRec[]>
  createComment(input: NewComment): Promise<CommentRec>
  setResolved(id: string, resolved: boolean): Promise<void>
  listReplies(commentId: string): Promise<ReplyRec[]>
  createReply(commentId: string, body: string): Promise<ReplyRec>
  subscribe(project: string, handlers: RealtimeHandlers): () => void
}

// PocketBase records are loosely typed; this is the minimal shape we read.
type AnyRecord = { [key: string]: any }

export function createPocketBaseBackend(baseUrl = '/__c11n/pb'): C11nBackend {
  const pb = new PocketBase(baseUrl)

  function mapMe(r: AnyRecord): Me {
    return { id: r.id, email: r.email, name: r.name || r.email }
  }

  /** Display name from an expanded author relation, if present. */
  function expandedAuthorName(r: AnyRecord): string | undefined {
    const a = r.expand?.author
    return a ? a.name || a.email : undefined
  }

  /** PB json fields arrive parsed; guard against string-encoded edge cases. */
  function parseAnchorMeta(v: unknown): CommentRec['anchorMeta'] {
    if (v == null) return null
    if (typeof v === 'string') {
      try {
        return JSON.parse(v)
      } catch {
        return null
      }
    }
    return v as CommentRec['anchorMeta']
  }

  function mapComment(r: AnyRecord): CommentRec {
    return {
      id: r.id,
      project: r.project,
      path: r.path,
      selector: r.selector,
      anchorMeta: parseAnchorMeta(r.anchorMeta),
      body: r.body,
      author: r.author,
      authorName: expandedAuthorName(r),
      resolved: !!r.resolved,
      created: r.created,
      updated: r.updated,
    }
  }

  function mapReply(r: AnyRecord): ReplyRec {
    return {
      id: r.id,
      comment: r.comment,
      body: r.body,
      author: r.author,
      authorName: expandedAuthorName(r),
      created: r.created,
    }
  }

  /** Current auth record or throw — used by writes that inject `author`. */
  function requireAuth(): AnyRecord {
    const r = pb.authStore.record
    if (!r) throw new Error('c11n: not signed in')
    return r
  }

  return {
    async login(email, password) {
      const res = await pb.collection('users').authWithPassword(email, password)
      return mapMe(res.record)
    },

    logout() {
      pb.authStore.clear()
    },

    me() {
      // authStore is hydrated from localStorage by the SDK, so this reflects
      // persisted sessions across page loads.
      const r = pb.authStore.record
      return r ? mapMe(r) : null
    },

    async listComments(project, path) {
      const records = await pb.collection('comments').getFullList({
        filter: pb.filter('project = {:project} && path = {:path}', { project, path }),
        sort: 'created',
        expand: 'author',
      })
      return records.map(mapComment)
    },

    async createComment(input) {
      const me = requireAuth()
      const rec = await pb.collection('comments').create({ ...input, author: me.id })
      return mapComment(rec)
    },

    async setResolved(id, resolved) {
      await pb.collection('comments').update(id, { resolved })
    },

    async listReplies(commentId) {
      const records = await pb.collection('replies').getFullList({
        filter: pb.filter('comment = {:commentId}', { commentId }),
        sort: 'created',
        expand: 'author',
      })
      return records.map(mapReply)
    },

    async createReply(commentId, body) {
      const me = requireAuth()
      const rec = await pb.collection('replies').create({
        comment: commentId,
        body,
        author: me.id,
      })
      return mapReply(rec)
    },

    subscribe(project, handlers) {
      const onComment = (e: { action: string; record: AnyRecord }) => {
        // Server-side filter already scopes to the project; keep a client-side
        // guard as belt-and-braces (and for backends without realtime filters).
        if (e.record.project !== project) return
        const rec = mapComment(e.record)
        if (e.action === 'create') handlers.onCommentCreate?.(rec)
        else if (e.action === 'update') handlers.onCommentUpdate?.(rec)
        else if (e.action === 'delete') handlers.onCommentDelete?.(rec)
      }

      // Replies carry no project field, so they can't be scoped without a
      // per-event lookup; subscribe to all and pass through. Consumers hold
      // the comments for the current project and can ignore unknown parents.
      const onReply = (e: { action: string; record: AnyRecord }) => {
        const rec = mapReply(e.record)
        if (e.action === 'create') handlers.onReplyCreate?.(rec)
        else if (e.action === 'update') handlers.onReplyUpdate?.(rec)
        else if (e.action === 'delete') handlers.onReplyDelete?.(rec)
      }

      // subscribe() returns a promise; realtime setup failures shouldn't
      // crash the overlay, so log-and-continue.
      pb.collection('comments')
        .subscribe('*', onComment, { filter: pb.filter('project = {:project}', { project }) })
        .catch((err) => console.warn('c11n: comments subscribe failed', err))
      pb.collection('replies')
        .subscribe('*', onReply)
        .catch((err) => console.warn('c11n: replies subscribe failed', err))

      return () => {
        pb.collection('comments').unsubscribe('*')
          .catch(() => { /* already disconnected */ })
        pb.collection('replies').unsubscribe('*')
          .catch(() => { /* already disconnected */ })
      }
    },
  }
}
