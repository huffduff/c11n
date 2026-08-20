import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setBackend } from '../src/lib/backend'
import type { C11nBackend, CommentRec, ReplyRec } from '../src/lib/api'
import type { Anchor } from '../src/lib/anchor'
import { PROJECT } from '../src/lib/project'
import { useCommentsStore } from '../src/stores/comments'

const anchor: Anchor = {
  selector: '#hero',
  meta: { tag: 'button', text: 'Buy now', rect: { x: 1, y: 2, width: 30, height: 40 } },
}

function rec(overrides: Partial<CommentRec> = {}): CommentRec {
  return {
    id: 'c1',
    project: PROJECT,
    path: '/pricing',
    selector: '#hero',
    anchorMeta: anchor.meta,
    body: 'Too expensive',
    author: 'u1',
    authorName: 'Tom',
    resolved: false,
    created: '2026-08-19 10:00:00',
    updated: '2026-08-19 10:00:00',
    ...overrides,
  }
}

function makeMockBackend(overrides: Partial<C11nBackend> = {}): C11nBackend {
  return {
    login: vi.fn(),
    logout: vi.fn(),
    me: vi.fn().mockReturnValue(null),
    listComments: vi.fn().mockResolvedValue([]),
    createComment: vi.fn().mockResolvedValue(rec()),
    setResolved: vi.fn().mockResolvedValue(undefined),
    listReplies: vi.fn().mockResolvedValue([]),
    createReply: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  }
}

describe('useCommentsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('PROJECT is the seeded default slug', () => {
    expect(PROJECT).toBe('default')
  })

  describe('setPath', () => {
    it('sets currentPath and loads comments via backend.listComments(PROJECT, path)', async () => {
      const loaded = [rec(), rec({ id: 'c2', resolved: true })]
      const mock = makeMockBackend({ listComments: vi.fn().mockResolvedValue(loaded) })
      setBackend(mock)
      const store = useCommentsStore()

      await store.setPath('/pricing')

      expect(mock.listComments).toHaveBeenCalledWith(PROJECT, '/pricing')
      expect(store.currentPath).toBe('/pricing')
      expect(store.items).toEqual(loaded)
      expect(store.loading).toBe(false)
      expect(store.error).toBeNull()
    })

    it('replaces items when navigating to another path', async () => {
      const mock = makeMockBackend({
        listComments: vi
          .fn()
          .mockResolvedValueOnce([rec()])
          .mockResolvedValueOnce([rec({ id: 'c9', path: '/about' })]),
      })
      setBackend(mock)
      const store = useCommentsStore()

      await store.setPath('/pricing')
      await store.setPath('/about')

      expect(store.items.map((c) => c.id)).toEqual(['c9'])
      expect(store.currentPath).toBe('/about')
    })

    it('sets error and keeps going when the load fails', async () => {
      const mock = makeMockBackend({
        listComments: vi.fn().mockRejectedValue(new Error('boom')),
      })
      setBackend(mock)
      const store = useCommentsStore()

      await store.setPath('/pricing')

      expect(store.error).toBe('Could not load comments')
      expect(store.items).toEqual([])
      expect(store.loading).toBe(false)
    })
  })

  describe('pick mode + compose lifecycle', () => {
    it('enterPickMode/exitPickMode toggle mode', () => {
      setBackend(makeMockBackend())
      const store = useCommentsStore()
      expect(store.mode).toBe('off')

      store.enterPickMode()
      expect(store.mode).toBe('pick')

      store.exitPickMode()
      expect(store.mode).toBe('off')
    })

    it('exitPickMode discards a pending anchor', () => {
      setBackend(makeMockBackend())
      const store = useCommentsStore()
      store.enterPickMode()
      store.beginCompose(anchor)

      store.exitPickMode()

      expect(store.pendingAnchor).toBeNull()
      expect(store.mode).toBe('off')
    })

    it('beginCompose stores the anchor and stays in pick mode', () => {
      setBackend(makeMockBackend())
      const store = useCommentsStore()
      store.enterPickMode()

      store.beginCompose(anchor)

      expect(store.pendingAnchor).toEqual(anchor)
      expect(store.mode).toBe('pick')
    })

    it('cancelCompose clears the anchor but keeps pick mode active', () => {
      setBackend(makeMockBackend())
      const store = useCommentsStore()
      store.enterPickMode()
      store.beginCompose(anchor)

      store.cancelCompose()

      expect(store.pendingAnchor).toBeNull()
      expect(store.mode).toBe('pick')
    })
  })

  describe('saveComment', () => {
    it('builds the NewComment from PROJECT/path/anchor, appends result, clears pending, exits mode', async () => {
      const saved = rec({ id: 'c-new', body: 'Make it pop' })
      const mock = makeMockBackend({ createComment: vi.fn().mockResolvedValue(saved) })
      setBackend(mock)
      const store = useCommentsStore()
      await store.setPath('/pricing')
      store.enterPickMode()
      store.beginCompose(anchor)

      await store.saveComment('Make it pop')

      expect(mock.createComment).toHaveBeenCalledWith({
        project: PROJECT,
        path: '/pricing',
        selector: anchor.selector,
        anchorMeta: anchor.meta,
        body: 'Make it pop',
      })
      expect(store.items).toContainEqual(saved)
      expect(store.items.find((c) => c.id === 'c-new')?.seq).toBe(undefined)
      expect(store.pendingAnchor).toBeNull()
      expect(store.mode).toBe('off')
      expect(store.loading).toBe(false)
      expect(store.error).toBeNull()
    })

    it('failure sets error and keeps the pending anchor for retry', async () => {
      const mock = makeMockBackend({
        createComment: vi.fn().mockRejectedValue(new Error('nope')),
      })
      setBackend(mock)
      const store = useCommentsStore()
      await store.setPath('/pricing')
      store.enterPickMode()
      store.beginCompose(anchor)

      await store.saveComment('Make it pop')

      expect(store.error).toBe('Could not save comment')
      expect(store.pendingAnchor).toEqual(anchor)
      expect(store.mode).toBe('pick')
      expect(store.items).toEqual([])
      expect(store.loading).toBe(false)
    })

    it('is a no-op without a pending anchor', async () => {
      const mock = makeMockBackend()
      setBackend(mock)
      const store = useCommentsStore()

      await store.saveComment('orphan text')

      expect(mock.createComment).not.toHaveBeenCalled()
    })
  })

  describe('getters', () => {
    it('keeps all items but splits unresolved/resolved for the current path', async () => {
      const loaded = [
        rec({ id: 'u-1' }),
        rec({ id: 'u-2' }),
        rec({ id: 'r-1', resolved: true }),
      ]
      setBackend(makeMockBackend({ listComments: vi.fn().mockResolvedValue(loaded) }))
      const store = useCommentsStore()
      await store.setPath('/pricing')

      expect(store.items).toHaveLength(3)
      expect(store.unresolvedForCurrentPath.map((c) => c.id)).toEqual(['u-1', 'u-2'])
      expect(store.resolvedForCurrentPath.map((c) => c.id)).toEqual(['r-1'])
      // forCurrentPath defaults to unresolved
      expect(store.forCurrentPath).toEqual(store.unresolvedForCurrentPath)
      expect(store.unresolvedCount).toBe(2)
    })

    it('ignores items from other paths', async () => {
      const loaded = [rec({ id: 'here' }), rec({ id: 'elsewhere', path: '/about' })]
      setBackend(makeMockBackend({ listComments: vi.fn().mockResolvedValue(loaded) }))
      const store = useCommentsStore()
      await store.setPath('/pricing')

      expect(store.unresolvedForCurrentPath.map((c) => c.id)).toEqual(['here'])
      expect(store.unresolvedCount).toBe(1)
    })
  })

  describe('realtime helpers', () => {
    it('upsertFromRealtime inserts unknown records and replaces known ones', () => {
      setBackend(makeMockBackend())
      const store = useCommentsStore()

      store.upsertFromRealtime(rec({ id: 'c1', seq: 1, body: 'v1' }))
      expect(store.items).toHaveLength(1)
      expect(store.items[0].seq).toBe(1)

      store.upsertFromRealtime(rec({ id: 'c1', seq: 1, body: 'v2' }))
      expect(store.items).toHaveLength(1)
      expect(store.items[0].body).toBe('v2')

      store.upsertFromRealtime(rec({ id: 'c2', seq: 2 }))
      expect(store.items.map((c) => c.id)).toEqual(['c1', 'c2'])
      expect(store.items[1].seq).toBe(2)
    })

    it('removeFromRealtime drops by id and tolerates unknown ids', () => {
      setBackend(makeMockBackend())
      const store = useCommentsStore()
      store.upsertFromRealtime(rec({ id: 'c1' }))

      store.removeFromRealtime('missing')
      expect(store.items).toHaveLength(1)

      store.removeFromRealtime('c1')
      expect(store.items).toHaveLength(0)
    })
  })

  describe('sidebar state', () => {
    it('toggleSidebar flips sidebarOpen', () => {
      setBackend(makeMockBackend())
      const store = useCommentsStore()
      expect(store.sidebarOpen).toBe(false)

      store.toggleSidebar()
      expect(store.sidebarOpen).toBe(true)

      store.toggleSidebar()
      expect(store.sidebarOpen).toBe(false)
    })

    it('loadSidebar fetches the project-wide list (no path argument)', async () => {
      const all = [rec({ id: 'c-here' }), rec({ id: 'c-away', path: '/about' })]
      const listComments = vi.fn().mockResolvedValue(all)
      setBackend(makeMockBackend({ listComments }))
      const store = useCommentsStore()

      await store.loadSidebar()

      expect(listComments).toHaveBeenCalledWith(PROJECT)
      expect(store.sidebarComments).toEqual(all)
      expect(store.sidebarLoading).toBe(false)
    })

    it('loadSidebar failure sets error and clears the loading flag', async () => {
      setBackend(makeMockBackend({ listComments: vi.fn().mockRejectedValue(new Error('boom')) }))
      const store = useCommentsStore()

      await store.loadSidebar()

      expect(store.error).toBe('Could not load comments')
      expect(store.sidebarLoading).toBe(false)
    })
  })

  describe('thread state', () => {
    it('openThread/closeThread set and clear activeCommentId', () => {
      setBackend(makeMockBackend())
      const store = useCommentsStore()
      expect(store.activeCommentId).toBeNull()

      store.openThread('c1')
      expect(store.activeCommentId).toBe('c1')

      store.closeThread()
      expect(store.activeCommentId).toBeNull()
    })
  })

  describe('loadReplies', () => {
    function replyRec(overrides: Partial<ReplyRec> = {}): ReplyRec {
      return {
        id: 'r1',
        comment: 'c1',
        body: 'Agreed',
        author: 'u2',
        authorName: 'Ana',
        created: '2026-08-19 10:05:00',
        ...overrides,
      }
    }

    it('fetches once and caches per comment', async () => {
      const listReplies = vi.fn().mockResolvedValue([replyRec()])
      setBackend(makeMockBackend({ listReplies }))
      const store = useCommentsStore()

      await store.loadReplies('c1')
      await store.loadReplies('c1')

      expect(listReplies).toHaveBeenCalledTimes(1)
      expect(listReplies).toHaveBeenCalledWith('c1')
      expect(store.replies.get('c1')).toEqual([replyRec()])
    })

    it('caches independently per comment id', async () => {
      const listReplies = vi
        .fn()
        .mockResolvedValueOnce([replyRec()])
        .mockResolvedValueOnce([replyRec({ id: 'r9', comment: 'c2' })])
      setBackend(makeMockBackend({ listReplies }))
      const store = useCommentsStore()

      await store.loadReplies('c1')
      await store.loadReplies('c2')

      expect(listReplies).toHaveBeenCalledTimes(2)
      expect(store.replies.get('c2')![0].id).toBe('r9')
    })

    it('addReply persists through the backend and appends to the cache', async () => {
      const created = replyRec({ id: 'r2', body: 'New reply' })
      const mock = makeMockBackend({
        listReplies: vi.fn().mockResolvedValue([replyRec()]),
        createReply: vi.fn().mockResolvedValue(created),
      })
      setBackend(mock)
      const store = useCommentsStore()
      await store.loadReplies('c1')

      await store.addReply('c1', 'New reply')

      expect(mock.createReply).toHaveBeenCalledWith('c1', 'New reply')
      expect(store.replies.get('c1')!.map((r) => r.id)).toEqual(['r1', 'r2'])
      expect(store.loading).toBe(false)
      expect(store.error).toBeNull()
    })

    it('addReply creates the cache entry when replies were never loaded', async () => {
      const created = replyRec({ id: 'r2' })
      setBackend(makeMockBackend({ createReply: vi.fn().mockResolvedValue(created) }))
      const store = useCommentsStore()

      await store.addReply('c1', 'first!')

      expect(store.replies.get('c1')).toEqual([created])
    })

    it('addReply failure sets error and leaves the cache untouched', async () => {
      setBackend(
        makeMockBackend({
          listReplies: vi.fn().mockResolvedValue([replyRec()]),
          createReply: vi.fn().mockRejectedValue(new Error('nope')),
        }),
      )
      const store = useCommentsStore()
      await store.loadReplies('c1')

      await store.addReply('c1', 'doomed')

      expect(store.error).toBe('Could not save reply')
      expect(store.replies.get('c1')).toHaveLength(1)
      expect(store.loading).toBe(false)
    })
  })

  describe('resolve', () => {
    it('marks the item resolved in place via backend.setResolved(id, true)', async () => {
      const mock = makeMockBackend({
        listComments: vi.fn().mockResolvedValue([rec({ id: 'c1' }), rec({ id: 'c2' })]),
      })
      setBackend(mock)
      const store = useCommentsStore()
      await store.setPath('/pricing')

      await store.resolve('c1')

      expect(mock.setResolved).toHaveBeenCalledWith('c1', true)
      expect(store.items.find((c) => c.id === 'c1')!.resolved).toBe(true)
      expect(store.items.find((c) => c.id === 'c2')!.resolved).toBe(false)
      expect(store.unresolvedForCurrentPath.map((c) => c.id)).toEqual(['c2'])
    })

    it('closes the thread when the resolved comment was active', async () => {
      setBackend(makeMockBackend({ listComments: vi.fn().mockResolvedValue([rec()]) }))
      const store = useCommentsStore()
      await store.setPath('/pricing')
      store.openThread('c1')

      await store.resolve('c1')

      expect(store.activeCommentId).toBeNull()
    })

    it('failure sets error and leaves the item unresolved', async () => {
      setBackend(
        makeMockBackend({
          listComments: vi.fn().mockResolvedValue([rec()]),
          setResolved: vi.fn().mockRejectedValue(new Error('nope')),
        }),
      )
      const store = useCommentsStore()
      await store.setPath('/pricing')
      store.openThread('c1')

      await store.resolve('c1')

      expect(store.error).toBe('Could not resolve comment')
      expect(store.items[0].resolved).toBe(false)
      expect(store.activeCommentId).toBe('c1')
    })
  })

  // Review fixes (Task 10 REQUEST_CHANGES): async race + mid-compose nav.
  describe('setPath guards', () => {
    it('ignores out-of-order responses from rapid navigations', async () => {
      let resolveSlow!: (v: CommentRec[]) => void
      const slow = new Promise<CommentRec[]>((r) => (resolveSlow = r))
      const mock = makeMockBackend({
        listComments: vi
          .fn()
          .mockReturnValueOnce(slow) // /a — resolves late
          .mockResolvedValueOnce([rec({ id: 'c-b', path: '/b' })]), // /b — fast
      })
      setBackend(mock)
      const store = useCommentsStore()

      const first = store.setPath('/a')
      await store.setPath('/b')
      expect(store.items.map((c) => c.id)).toEqual(['c-b'])
      expect(store.loading).toBe(false)

      // The stale /a response lands after /b already settled — must be ignored.
      resolveSlow([rec({ id: 'c-a-stale', path: '/a' })])
      await first
      expect(store.currentPath).toBe('/b')
      expect(store.items.map((c) => c.id)).toEqual(['c-b'])
      expect(store.loading).toBe(false)
    })

    it('abandons a pending compose and open thread on navigation', async () => {
      const mock = makeMockBackend()
      setBackend(mock)
      const store = useCommentsStore()

      store.enterPickMode()
      store.beginCompose(anchor)
      store.openThread('c1')
      await store.setPath('/elsewhere')

      expect(store.pendingAnchor).toBeNull()
      expect(store.mode).toBe('off')
      expect(store.activeCommentId).toBeNull()
      // A save attempted after nav must be a no-op (no wrong-page comment).
      await store.saveComment('stale draft')
      expect(mock.createComment).not.toHaveBeenCalled()
    })
  })
})
