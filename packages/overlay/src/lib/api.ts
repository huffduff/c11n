import PocketBase from 'pocketbase'
import type { CommentRec, Me, NewComment, RealtimeHandlers, ReplyRec } from './types'

export type { CommentRec, Me, NewComment, RealtimeHandlers, ReplyRec }

/**
 * Swappable data-access layer for the overlay. The UI only ever talks to
 * this interface; `createPocketBaseBackend` is the v1 implementation.
 * A later Go swap reimplements these 8 methods + SSE behind `subscribe`.
 */
export interface C11nBackend {
  login(email: string, password: string): Promise<Me>
  logout(): void
  me(): Me | null
  /**
   * Comments sorted by `created` asc. With `path`: the hot per-page query.
   * Without `path`: every comment in the project (sidebar listing) — any
   * replacement backend must honor both shapes.
   */
  listComments(project: string, path?: string): Promise<CommentRec[]>
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

  // The overlay deals in project *slugs* (`window.__C11N_PROJECT` → 'default'),
  // but PocketBase stores `comments.project` as a relation holding the project
  // *record id* — sending the slug fails validation (missing_rel_records).
  // Resolve slug → id lazily, once per slug, so the C11nBackend interface stays
  // slug-based (a future Go backend can accept slugs natively) and only this
  // implementation translates at the edge.
  const projectIdBySlug = new Map<string, Promise<string>>()
  const slugById = new Map<string, string>()

  function resolveProjectId(slug: string): Promise<string> {
    let pending = projectIdBySlug.get(slug)
    if (!pending) {
      pending = pb
        .collection('projects')
        .getFirstListItem(pb.filter('slug = {:slug}', { slug }))
        .then((rec: AnyRecord) => {
          slugById.set(rec.id, slug)
          return rec.id as string
        })
        .catch((err: unknown) => {
          // Don't cache failures (e.g. lookup before login) — retry next call.
          projectIdBySlug.delete(slug)
          throw err
        })
      projectIdBySlug.set(slug, pending)
    }
    return pending
  }

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
      // Stored as a record id; surface the slug the overlay knows when we
      // have it (resolved earlier in this session), else pass through as-is.
      project: slugById.get(r.project) ?? r.project,
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
      const projectId = await resolveProjectId(project)
      // Path omitted → project-wide list (sidebar); provided → per-page load.
      const filter =
        path === undefined
          ? pb.filter('project = {:projectId}', { projectId })
          : pb.filter('project = {:projectId} && path = {:path}', { projectId, path })
      const records = await pb.collection('comments').getFullList({
        filter,
        sort: 'created',
        expand: 'author',
      })
      return records.map(mapComment)
    },

    async createComment(input) {
      const me = requireAuth()
      const projectId = await resolveProjectId(input.project)
      const rec = await pb
        .collection('comments')
        .create({ ...input, project: projectId, author: me.id })
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
      // Setup is async (slug → id lookup) but the interface returns a sync
      // unsubscribe; the cancelled flag closes the race where the caller
      // unsubscribes before the lookup lands.
      let cancelled = false

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
      resolveProjectId(project)
        .then((projectId) => {
          if (cancelled) return

          const onComment = (e: { action: string; record: AnyRecord }) => {
            // Server-side filter already scopes to the project; keep a client-
            // side guard as belt-and-braces (records store the project id).
            if (e.record.project !== projectId) return
            const rec = mapComment(e.record)
            if (e.action === 'create') handlers.onCommentCreate?.(rec)
            else if (e.action === 'update') handlers.onCommentUpdate?.(rec)
            else if (e.action === 'delete') handlers.onCommentDelete?.(rec)
          }

          pb.collection('comments')
            .subscribe('*', onComment, {
              filter: pb.filter('project = {:projectId}', { projectId }),
            })
            .catch((err) => console.warn('c11n: comments subscribe failed', err))
          pb.collection('replies')
            .subscribe('*', onReply)
            .catch((err) => console.warn('c11n: replies subscribe failed', err))
        })
        .catch((err) => console.warn('c11n: project lookup failed, realtime disabled', err))

      return () => {
        cancelled = true
        pb.collection('comments').unsubscribe('*')
          .catch(() => { /* already disconnected */ })
        pb.collection('replies').unsubscribe('*')
          .catch(() => { /* already disconnected */ })
      }
    },
  }
}
