import PocketBase, { BaseAuthStore } from 'pocketbase'
import { goToSignIn } from './signin'
import type { CommentRec, InviteResult, Me, NewComment, RealtimeHandlers, ReplyRec, Role } from './types'

export type { CommentRec, InviteResult, Me, NewComment, RealtimeHandlers, ReplyRec, Role }

/**
 * Swappable data-access layer for the overlay. The UI only ever talks to
 * this interface; `createPocketBaseBackend` is the v1 implementation.
 * A later Go swap reimplements these methods + SSE behind `subscribe`.
 *
 * Identity is the proxy's, not the page's (ADR 0006): the backend never holds
 * a token, `me()` reads the session cookie through the proxy and `logout()`
 * clears that cookie before leaving for the sign-in page.
 */
export interface C11nBackend {
  /** The signed-in user, or null when the session cookie is gone/expired. */
  me(): Promise<Me | null>
  /** Clears the cookie (public route) and navigates to the sign-in page. */
  logout(): Promise<void>
  /** Owner/team: mint a copy-link invite for `email` at `role`. */
  invite(email: string, role: Role): Promise<InviteResult>
  /**
   * Comments sorted by `created` asc. With `path`: the hot per-page query.
   * Without `path`: every comment in the project (sidebar listing) — any
   * replacement backend must honor both shapes.
   */
  listComments(project: string, path?: string): Promise<CommentRec[]>
  createComment(input: NewComment): Promise<CommentRec>
  setResolved(id: string, resolved: boolean): Promise<void>
  /** Owner (any comment) or author (own). The rules answer the same question. */
  deleteComment(id: string): Promise<void>
  listReplies(commentId: string): Promise<ReplyRec[]>
  createReply(commentId: string, body: string): Promise<ReplyRec>
  subscribe(project: string, handlers: RealtimeHandlers): () => void
}

// PocketBase records are loosely typed; this is the minimal shape we read.
type AnyRecord = { [key: string]: any }

export function createPocketBaseBackend(baseUrl = '/__c11n/pb'): C11nBackend {
  // An in-memory auth store on purpose: the SDK's default LocalAuthStore
  // persists a token in localStorage, which is exactly the exposure ADR 0006
  // removes. The SDK never authenticates here at all — Caddy turns the
  // httpOnly c11n_session cookie into Authorization for /__c11n/pb/*.
  const pb = new PocketBase(baseUrl, new BaseAuthStore())

  // Last successful `me()`. Writes need the author id, and the SDK has no
  // record to read it from — every request is authenticated by the proxy, not
  // by a token this page owns.
  let current: Me | null = null

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
      pending = guard(() =>
        pb
          .collection('projects')
          .getFirstListItem(pb.filter('slug = {:slug}', { slug })),
      )
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
    return { id: r.id, email: r.email, name: r.name || r.email, role: (r.role as Role) ?? 'client' }
  }

  // M-4: a 401 from ANY request means the session cookie died — it expired, or
  // a sign-out in another tab rotated the user's tokenKey. Only `me()` used to
  // notice, so a write would throw while the UI still claimed the user was
  // signed in. Every SDK call goes through `guard`, which hands the user to
  // the sign-in page once and then lets the original error through.
  let redirecting = false
  /** Route a dead-session answer to the sign-in page, once. */
  function noteUnauthorized(status: number): void {
    if (redirecting || status !== 401) return
    redirecting = true
    current = null
    goToSignIn('expired')
  }

  async function guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (err) {
      const e = err as { status?: number; response?: { status?: number } } | null
      noteUnauthorized(e?.status ?? e?.response?.status ?? 0)
      throw err
    }
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
      seq: typeof r.seq === 'number' ? r.seq : undefined,
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

  /** The session user, or throw — used by writes that inject `author`. */
  function requireAuth(): Me {
    if (!current) throw new Error('c11n: not signed in')
    return current
  }

  return {
    async me() {
      const res = await fetch(`${baseUrl}/api/c11n/me`, {
        headers: { Accept: 'application/json' },
        // Same origin, and the cookie is HttpOnly: the browser attaches it and
        // Caddy turns it into Authorization before PocketBase sees the request.
        credentials: 'same-origin',
      })
      if (res.status === 401) {
        current = null
        return null
      }
      if (!res.ok) throw new Error(`c11n: me failed (${res.status})`)
      const body = (await res.json()) as AnyRecord
      current = mapMe(body)
      return current
    },

    async logout() {
      current = null
      pb.authStore.clear()
      try {
        await fetch('/__c11n/auth/logout', { method: 'POST', credentials: 'same-origin' })
      } finally {
        // Leave even if clearing failed: staying on a page the gate will
        // reject on the next request is worse than one extra sign-in.
        location.assign('/__c11n/auth/?reason=signed-out')
      }
    },

    async invite(email, role) {
      const res = await fetch(`${baseUrl}/api/c11n/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, role }),
      })
      const text = await res.text()
      let body: { link?: string; expiresAt?: string; message?: string } = {}
      try {
        body = text ? (JSON.parse(text) as typeof body) : {}
      } catch {
        // A non-JSON body is an error page, not an invite.
      }
      if (!res.ok) {
        // M-4: an invite with no session is the same dead-session answer as an
        // SDK call; route it the same way (once).
        noteUnauthorized(res.status)
        const err = new Error(body.message || `Invite failed (${res.status})`) as Error & {
          status?: number
        }
        err.status = res.status
        throw err
      }
      if (!body.link) throw new Error('Invite returned no link')
      return { link: body.link, expiresAt: body.expiresAt ?? '' }
    },

    async listComments(project, path) {
      const projectId = await resolveProjectId(project)
      // Path omitted → project-wide list (sidebar); provided → per-page load.
      const filter =
        path === undefined
          ? pb.filter('project = {:projectId}', { projectId })
          : pb.filter('project = {:projectId} && path = {:path}', { projectId, path })
      const records = await guard(() =>
        pb.collection('comments').getFullList({
          filter,
          sort: 'created',
          expand: 'author',
        }),
      )
      return records.map(mapComment)
    },

    async createComment(input) {
      const me = requireAuth()
      const projectId = await resolveProjectId(input.project)
      // Expand the author: the create response is upserted over the realtime
      // echo, and the echo carries no expand — without this the HTTP record
      // (authorName undefined) would blank the name backfilled from session.
      const rec = await guard(() =>
        pb
          .collection('comments')
          .create({ ...input, project: projectId, author: me.id }, { expand: 'author' }),
      )
      return mapComment(rec)
    },

    async setResolved(id, resolved) {
      await guard(() => pb.collection('comments').update(id, { resolved }))
    },

    async deleteComment(id) {
      // The replies cascade server-side (the `replies.comment` relation is
      // cascadeDelete), so there is no second call to make here.
      await guard(() => pb.collection('comments').delete(id))
    },

    async listReplies(commentId) {
      const records = await guard(() =>
        pb.collection('replies').getFullList({
          filter: pb.filter('comment = {:commentId}', { commentId }),
          sort: 'created',
          expand: 'author',
        }),
      )
      return records.map(mapReply)
    },

    async createReply(commentId, body) {
      const me = requireAuth()
      // Same reason as createComment: keep the display name on the record the
      // caller upserts over the (unexpanded) realtime echo.
      const rec = await guard(() =>
        pb.collection('replies').create(
          {
            comment: commentId,
            body,
            author: me.id,
          },
          { expand: 'author' },
        ),
      )
      return mapReply(rec)
    },

    subscribe(project, handlers) {
      // Setup is async (slug → id lookup) but the interface returns a sync
      // unsubscribe; the cancelled flag closes the race where the caller
      // unsubscribes before the lookup lands.
      let cancelled = false

      // Replies carry no project field — the project lives on the parent
      // comment — so the subscription is scoped through the relation:
      // `comment.project = <id>`. PocketBase 0.39 applies realtime filters
      // server-side, including relation traversal (proved by
      // e2e/specs/realtime-scope.spec.ts: a reply in project Y never reaches
      // a project-X subscriber). Without it, every authenticated user would
      // receive every reply body on the server. The store still ignores
      // replies it has no comment for, which covers the moment between a
      // comment arriving and this filter being in effect.
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
            .subscribe('*', onReply, {
              filter: pb.filter('comment.project = {:projectId}', { projectId }),
            })
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
