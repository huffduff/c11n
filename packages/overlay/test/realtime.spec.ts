import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setBackend } from '../src/lib/backend'
import type { C11nBackend, CommentRec, Me, RealtimeHandlers, ReplyRec } from '../src/lib/api'
import { PROJECT } from '../src/lib/project'
import { useCommentsStore } from '../src/stores/comments'
import { useSessionStore } from '../src/stores/session'

const tom: Me = { id: 'u1', email: 'tom@hfdf.io', name: 'Tom' }

function rec(overrides: Partial<CommentRec> = {}): CommentRec {
  return {
    id: 'c1',
    project: PROJECT,
    path: '/pricing',
    selector: '#hero',
    anchorMeta: null,
    body: 'Too expensive',
    author: 'u2',
    // Live events never carry expand.author — authorName arrives undefined.
    authorName: undefined,
    resolved: false,
    created: '2026-08-19 10:00:00',
    updated: '2026-08-19 10:00:00',
    ...overrides,
  }
}

function replyRec(overrides: Partial<ReplyRec> = {}): ReplyRec {
  return {
    id: 'r1',
    comment: 'c1',
    body: 'Agreed',
    author: 'u2',
    authorName: undefined,
    created: '2026-08-19 10:05:00',
    ...overrides,
  }
}

function makeMockBackend(overrides: Partial<C11nBackend> = {}): C11nBackend {
  return {
    login: vi.fn(),
    logout: vi.fn(),
    me: vi.fn().mockReturnValue(null),
    listComments: vi.fn().mockResolvedValue([]),
    createComment: vi.fn(),
    setResolved: vi.fn().mockResolvedValue(undefined),
    listReplies: vi.fn().mockResolvedValue([]),
    createReply: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  }
}

/** Wire a store to a backend whose subscribe captures the handlers. */
function wire(overrides: Partial<C11nBackend> = {}) {
  let captured: RealtimeHandlers = {}
  const unsubscribe = vi.fn()
  const subscribe = vi.fn((_project: string, h: RealtimeHandlers) => {
    captured = h
    return unsubscribe
  })
  setBackend(makeMockBackend({ subscribe, ...overrides }))
  const store = useCommentsStore()
  store.startRealtime()
  return { store, subscribe, unsubscribe, handlers: () => captured }
}

describe('comments store realtime', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('startRealtime / stopRealtime lifecycle', () => {
    it('subscribes once with the PROJECT slug', () => {
      const { subscribe } = wire()
      expect(subscribe).toHaveBeenCalledTimes(1)
      expect(subscribe).toHaveBeenCalledWith(PROJECT, expect.any(Object))
    })

    it('startRealtime twice does not double-subscribe', () => {
      const { store, subscribe } = wire()
      store.startRealtime()
      expect(subscribe).toHaveBeenCalledTimes(1)
    })

    it('stopRealtime unsubscribes and is idempotent', () => {
      const { store, unsubscribe } = wire()
      store.stopRealtime()
      expect(unsubscribe).toHaveBeenCalledTimes(1)
      store.stopRealtime()
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    })

    it('stopRealtime is safe when realtime was never started', () => {
      setBackend(makeMockBackend())
      const store = useCommentsStore()
      expect(() => store.stopRealtime()).not.toThrow()
    })

    it('can resubscribe after stopRealtime', () => {
      const { store, subscribe } = wire()
      store.stopRealtime()
      store.startRealtime()
      expect(subscribe).toHaveBeenCalledTimes(2)
    })
  })

  describe('comment events', () => {
    it('create adds to items and sidebarComments', () => {
      const { store, handlers } = wire()
      handlers().onCommentCreate!(rec({ id: 'c-live' }))

      expect(store.items.map((c) => c.id)).toEqual(['c-live'])
      expect(store.sidebarComments.map((c) => c.id)).toEqual(['c-live'])
    })

    it('update replaces the record in items and sidebarComments', () => {
      const { store, handlers } = wire()
      handlers().onCommentCreate!(rec({ id: 'c1', body: 'v1' }))
      handlers().onCommentUpdate!(rec({ id: 'c1', body: 'v2', resolved: true }))

      expect(store.items).toHaveLength(1)
      expect(store.items[0]).toMatchObject({ body: 'v2', resolved: true })
      expect(store.sidebarComments).toHaveLength(1)
      expect(store.sidebarComments[0]).toMatchObject({ body: 'v2', resolved: true })
    })

    it('delete removes from items and sidebarComments', () => {
      const { store, handlers } = wire()
      handlers().onCommentCreate!(rec({ id: 'c1' }))
      handlers().onCommentCreate!(rec({ id: 'c2' }))
      handlers().onCommentDelete!(rec({ id: 'c1' }))

      expect(store.items.map((c) => c.id)).toEqual(['c2'])
      expect(store.sidebarComments.map((c) => c.id)).toEqual(['c2'])
    })
  })

  describe('author backfill (live events carry no expand.author)', () => {
    it("backfills authorName from the session when the event's author is me", () => {
      const session = useSessionStore()
      const { store, handlers } = wire()
      session.me = tom

      handlers().onCommentCreate!(rec({ id: 'c-mine', author: tom.id }))
      expect(store.items[0].authorName).toBe('Tom')
      expect(store.sidebarComments[0].authorName).toBe('Tom')
    })

    it('leaves authorName undefined for other authors (UI falls back)', () => {
      const session = useSessionStore()
      const { store, handlers } = wire()
      session.me = tom

      handlers().onCommentCreate!(rec({ id: 'c-theirs', author: 'u2' }))
      expect(store.items[0].authorName).toBeUndefined()
    })

    it('backfills reply authorName for own replies in a known thread', () => {
      const session = useSessionStore()
      const { store, handlers } = wire()
      session.me = tom
      store.replies.set('c1', [])

      handlers().onReplyCreate!(replyRec({ id: 'r-mine', author: tom.id }))
      expect(store.replies.get('c1')![0].authorName).toBe('Tom')
    })
  })

  describe('reply events (unscoped stream → consumer-side filtering)', () => {
    it('create appends to the cache only for known comment ids', () => {
      const { store, handlers } = wire()
      store.replies.set('c1', [replyRec({ id: 'r0' })])

      handlers().onReplyCreate!(replyRec({ id: 'r-new' }))
      expect(store.replies.get('c1')!.map((r) => r.id)).toEqual(['r0', 'r-new'])
    })

    it('create for an unknown comment id is a no-op', () => {
      const { store, handlers } = wire()
      handlers().onReplyCreate!(replyRec({ id: 'r-x', comment: 'c-unknown' }))
      expect(store.replies.has('c-unknown')).toBe(false)
    })

    it('create dedupes replies already in the cache (own optimistic reply)', () => {
      const { store, handlers } = wire()
      store.replies.set('c1', [replyRec({ id: 'r1' })])

      handlers().onReplyCreate!(replyRec({ id: 'r1' }))
      expect(store.replies.get('c1')).toHaveLength(1)
    })

    it('update replaces the cached reply in place; unknown ids are no-ops', () => {
      const { store, handlers } = wire()
      store.replies.set('c1', [replyRec({ id: 'r1', body: 'v1' })])

      handlers().onReplyUpdate!(replyRec({ id: 'r1', body: 'v2' }))
      expect(store.replies.get('c1')![0].body).toBe('v2')

      handlers().onReplyUpdate!(replyRec({ id: 'r9', comment: 'c-unknown' }))
      expect(store.replies.has('c-unknown')).toBe(false)
    })

    it('delete drops the cached reply; unknown comment ids are no-ops', () => {
      const { store, handlers } = wire()
      store.replies.set('c1', [replyRec({ id: 'r1' }), replyRec({ id: 'r2' })])

      handlers().onReplyDelete!(replyRec({ id: 'r1' }))
      expect(store.replies.get('c1')!.map((r) => r.id)).toEqual(['r2'])

      expect(() => handlers().onReplyDelete!(replyRec({ id: 'rz', comment: 'nope' }))).not.toThrow()
    })
  })
})
