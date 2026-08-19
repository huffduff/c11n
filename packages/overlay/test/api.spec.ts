import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock the pocketbase SDK. The mock records constructor args, exposes per-
// collection vi.fn()s, and implements just enough of authStore / pb.filter
// for the backend to run against it.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const state = {
    instances: [] as any[],
    reset() {
      state.instances.length = 0
    },
  }

  function makeCollection() {
    return {
      authWithPassword: vi.fn(),
      getFullList: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
    }
  }

  class MockPocketBase {
    baseUrl: string
    authStore: { record: any; clear: () => void }
    private cols = new Map<string, ReturnType<typeof makeCollection>>()

    constructor(baseUrl: string) {
      this.baseUrl = baseUrl
      this.authStore = {
        record: null,
        clear: vi.fn(() => {
          this.authStore.record = null
        }),
      }
      state.instances.push(this)
    }

    collection(name: string) {
      if (!this.cols.has(name)) this.cols.set(name, makeCollection())
      return this.cols.get(name)!
    }

    filter(expr: string, params: Record<string, unknown> = {}) {
      return expr.replace(/\{:(\w+)\}/g, (_m, k: string) => JSON.stringify(params[k]))
    }
  }

  return { state, MockPocketBase }
})

vi.mock('pocketbase', () => ({ default: h.MockPocketBase }))

import { createPocketBaseBackend } from '../src/lib/api'
import type { C11nBackend } from '../src/lib/api'

function setup(baseUrl?: string) {
  const backend = baseUrl ? createPocketBaseBackend(baseUrl) : createPocketBaseBackend()
  const pb = h.state.instances[h.state.instances.length - 1]
  return { backend: backend as C11nBackend, pb }
}

const userRecord = { id: 'u1', email: 'alice@example.com', name: 'Alice' }

beforeEach(() => {
  h.state.reset()
})

describe('createPocketBaseBackend', () => {
  it('defaults baseUrl to /__c11n/pb', () => {
    const { pb } = setup()
    expect(pb.baseUrl).toBe('/__c11n/pb')
  })

  it('honors an explicit baseUrl', () => {
    const { pb } = setup('http://localhost:8090')
    expect(pb.baseUrl).toBe('http://localhost:8090')
  })
})

describe('login / logout / me', () => {
  it('login maps the auth record to Me', async () => {
    const { backend, pb } = setup()
    pb.collection('users').authWithPassword.mockResolvedValue({
      token: 't',
      record: userRecord,
    })

    const me = await backend.login('alice@example.com', 'pw')

    expect(pb.collection('users').authWithPassword).toHaveBeenCalledWith(
      'alice@example.com',
      'pw',
    )
    expect(me).toEqual({ id: 'u1', email: 'alice@example.com', name: 'Alice' })
  })

  it('login falls back to email when the record has no name', async () => {
    const { backend, pb } = setup()
    pb.collection('users').authWithPassword.mockResolvedValue({
      token: 't',
      record: { id: 'u2', email: 'bob@example.com', name: '' },
    })

    const me = await backend.login('bob@example.com', 'pw')
    expect(me.name).toBe('bob@example.com')
  })

  it('me() is null when the auth store is empty', () => {
    const { backend } = setup()
    expect(backend.me()).toBeNull()
  })

  it('me() reflects a persisted auth store record', () => {
    const { backend, pb } = setup()
    pb.authStore.record = userRecord
    expect(backend.me()).toEqual({ id: 'u1', email: 'alice@example.com', name: 'Alice' })
  })

  it('logout clears the auth store', () => {
    const { backend, pb } = setup()
    pb.authStore.record = userRecord
    backend.logout()
    expect(pb.authStore.clear).toHaveBeenCalled()
    expect(backend.me()).toBeNull()
  })
})

describe('listComments', () => {
  it('queries with a parameterized project+path filter, sorted, expanding author', async () => {
    const { backend, pb } = setup()
    await backend.listComments('proj1', '/pricing')

    expect(pb.collection('comments').getFullList).toHaveBeenCalledWith({
      filter: 'project = "proj1" && path = "/pricing"',
      sort: 'created',
      expand: 'author',
    })
  })

  it('omitting path queries project-wide (sidebar list) with the same sort/expand', async () => {
    const { backend, pb } = setup()
    await backend.listComments('proj1')

    expect(pb.collection('comments').getFullList).toHaveBeenCalledWith({
      filter: 'project = "proj1"',
      sort: 'created',
      expand: 'author',
    })
  })

  it('maps records, pulling authorName from expand.author (name, then email)', async () => {
    const { backend, pb } = setup()
    const anchorMeta = {
      tag: 'h1',
      text: 'Pricing',
      rect: { x: 1, y: 2, width: 3, height: 4 },
    }
    pb.collection('comments').getFullList.mockResolvedValue([
      {
        id: 'c1',
        project: 'proj1',
        path: '/pricing',
        selector: 'h1',
        anchorMeta,
        body: 'too expensive',
        author: 'u1',
        resolved: false,
        created: '2026-01-01 00:00:00Z',
        updated: '2026-01-02 00:00:00Z',
        expand: { author: { id: 'u1', email: 'alice@example.com', name: 'Alice' } },
      },
      {
        id: 'c2',
        project: 'proj1',
        path: '/pricing',
        selector: 'p',
        anchorMeta: null,
        body: 'typo here',
        author: 'u2',
        resolved: true,
        created: '2026-01-03 00:00:00Z',
        updated: '2026-01-03 00:00:00Z',
        expand: { author: { id: 'u2', email: 'bob@example.com', name: '' } },
      },
      {
        id: 'c3',
        project: 'proj1',
        path: '/pricing',
        selector: 'div',
        anchorMeta: null,
        body: 'no expand at all',
        author: 'u3',
        resolved: false,
        created: '2026-01-04 00:00:00Z',
        updated: '2026-01-04 00:00:00Z',
      },
    ])

    const out = await backend.listComments('proj1', '/pricing')

    expect(out).toEqual([
      {
        id: 'c1',
        project: 'proj1',
        path: '/pricing',
        selector: 'h1',
        anchorMeta,
        body: 'too expensive',
        author: 'u1',
        authorName: 'Alice',
        resolved: false,
        created: '2026-01-01 00:00:00Z',
        updated: '2026-01-02 00:00:00Z',
      },
      expect.objectContaining({ id: 'c2', authorName: 'bob@example.com', resolved: true }),
      expect.objectContaining({ id: 'c3', authorName: undefined }),
    ])
  })
})

describe('createComment', () => {
  const input = {
    project: 'proj1',
    path: '/pricing',
    selector: 'h1',
    anchorMeta: null,
    body: 'hello',
  }

  it('throws when unauthenticated', async () => {
    const { backend } = setup()
    await expect(backend.createComment(input)).rejects.toThrow(/not (signed in|authenticated)/i)
  })

  it('injects author from the auth store and maps the created record', async () => {
    const { backend, pb } = setup()
    pb.authStore.record = userRecord
    pb.collection('comments').create.mockResolvedValue({
      id: 'c9',
      ...input,
      author: 'u1',
      resolved: false,
      created: 'x',
      updated: 'x',
    })

    const rec = await backend.createComment(input)

    expect(pb.collection('comments').create).toHaveBeenCalledWith({
      ...input,
      author: 'u1',
    })
    expect(rec).toEqual(
      expect.objectContaining({ id: 'c9', author: 'u1', body: 'hello', resolved: false }),
    )
  })
})

describe('setResolved', () => {
  it('updates only the resolved field', async () => {
    const { backend, pb } = setup()
    await backend.setResolved('c1', true)
    expect(pb.collection('comments').update).toHaveBeenCalledWith('c1', { resolved: true })

    await backend.setResolved('c1', false)
    expect(pb.collection('comments').update).toHaveBeenCalledWith('c1', { resolved: false })
  })
})

describe('replies', () => {
  it('listReplies filters by comment, sorted, expanding author', async () => {
    const { backend, pb } = setup()
    pb.collection('replies').getFullList.mockResolvedValue([
      {
        id: 'r1',
        comment: 'c1',
        body: 'agreed',
        author: 'u2',
        created: 'x',
        expand: { author: { id: 'u2', email: 'bob@example.com', name: 'Bob' } },
      },
    ])

    const out = await backend.listReplies('c1')

    expect(pb.collection('replies').getFullList).toHaveBeenCalledWith({
      filter: 'comment = "c1"',
      sort: 'created',
      expand: 'author',
    })
    expect(out).toEqual([
      { id: 'r1', comment: 'c1', body: 'agreed', author: 'u2', authorName: 'Bob', created: 'x' },
    ])
  })

  it('createReply requires auth and injects author', async () => {
    const { backend, pb } = setup()
    await expect(backend.createReply('c1', 'hi')).rejects.toThrow()

    pb.authStore.record = userRecord
    pb.collection('replies').create.mockResolvedValue({
      id: 'r2',
      comment: 'c1',
      body: 'hi',
      author: 'u1',
      created: 'x',
    })

    const rec = await backend.createReply('c1', 'hi')
    expect(pb.collection('replies').create).toHaveBeenCalledWith({
      comment: 'c1',
      body: 'hi',
      author: 'u1',
    })
    expect(rec).toEqual({ id: 'r2', comment: 'c1', body: 'hi', author: 'u1', authorName: undefined, created: 'x' })
  })
})

describe('subscribe', () => {
  const commentRecord = {
    id: 'c1',
    project: 'proj1',
    path: '/a',
    selector: 'h1',
    anchorMeta: null,
    body: 'b',
    author: 'u1',
    resolved: false,
    created: 'x',
    updated: 'x',
  }
  const replyRecord = { id: 'r1', comment: 'c1', body: 'rb', author: 'u1', created: 'x' }

  function wire() {
    const { backend, pb } = setup()
    const handlers = {
      onCommentCreate: vi.fn(),
      onCommentUpdate: vi.fn(),
      onCommentDelete: vi.fn(),
      onReplyCreate: vi.fn(),
      onReplyUpdate: vi.fn(),
      onReplyDelete: vi.fn(),
    }
    const unsubscribe = backend.subscribe('proj1', handlers)
    const commentCb = pb.collection('comments').subscribe.mock.calls[0][1]
    const replyCb = pb.collection('replies').subscribe.mock.calls[0][1]
    return { backend, pb, handlers, unsubscribe, commentCb, replyCb }
  }

  it('subscribes to both collections, scoping comments to the project', () => {
    const { pb } = wire()

    expect(pb.collection('comments').subscribe).toHaveBeenCalledWith(
      '*',
      expect.any(Function),
      { filter: 'project = "proj1"' },
    )
    expect(pb.collection('replies').subscribe).toHaveBeenCalledWith('*', expect.any(Function))
  })

  it('dispatches comment events to the matching handlers with mapped records', () => {
    const { handlers, commentCb } = wire()

    commentCb({ action: 'create', record: commentRecord })
    expect(handlers.onCommentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', project: 'proj1', authorName: undefined }),
    )

    commentCb({ action: 'update', record: commentRecord })
    expect(handlers.onCommentUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }))

    commentCb({ action: 'delete', record: commentRecord })
    expect(handlers.onCommentDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }))

    expect(handlers.onReplyCreate).not.toHaveBeenCalled()
  })

  it('ignores comment events from other projects (client-side belt and braces)', () => {
    const { handlers, commentCb } = wire()
    commentCb({ action: 'create', record: { ...commentRecord, project: 'other' } })
    expect(handlers.onCommentCreate).not.toHaveBeenCalled()
  })

  it('dispatches reply events to the matching handlers', () => {
    const { handlers, replyCb } = wire()

    replyCb({ action: 'create', record: replyRecord })
    expect(handlers.onReplyCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r1', comment: 'c1' }),
    )

    replyCb({ action: 'update', record: replyRecord })
    expect(handlers.onReplyUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }))

    replyCb({ action: 'delete', record: replyRecord })
    expect(handlers.onReplyDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }))

    expect(handlers.onCommentCreate).not.toHaveBeenCalled()
  })

  it('tolerates missing handlers', () => {
    const { backend, pb } = setup()
    backend.subscribe('proj1', {})
    const commentCb = pb.collection('comments').subscribe.mock.calls[0][1]
    expect(() => commentCb({ action: 'create', record: commentRecord })).not.toThrow()
  })

  it('returned function unsubscribes both collections', () => {
    const { pb, unsubscribe } = wire()
    unsubscribe()
    expect(pb.collection('comments').unsubscribe).toHaveBeenCalledWith('*')
    expect(pb.collection('replies').unsubscribe).toHaveBeenCalledWith('*')
  })
})
