import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setBackend } from '../src/lib/backend'
import type { C11nBackend, CommentRec } from '../src/lib/api'
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

      store.upsertFromRealtime(rec({ id: 'c1', body: 'v1' }))
      expect(store.items).toHaveLength(1)

      store.upsertFromRealtime(rec({ id: 'c1', body: 'v2' }))
      expect(store.items).toHaveLength(1)
      expect(store.items[0].body).toBe('v2')

      store.upsertFromRealtime(rec({ id: 'c2' }))
      expect(store.items.map((c) => c.id)).toEqual(['c1', 'c2'])
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
})
