import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
      getFirstListItem: vi.fn(),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
    }
  }

  class MockAuthStore {
    token = ''
    record: any = null
    clear() {
      this.token = ''
      this.record = null
    }
  }

  class MockPocketBase {
    baseUrl: string
    authStore: any
    private cols = new Map<string, ReturnType<typeof makeCollection>>()

    constructor(baseUrl: string, authStore?: any) {
      this.baseUrl = baseUrl
      // Mirrors the real SDK: without an explicit store it would fall back to
      // the localStorage-backed LocalAuthStore, which api.ts must never use.
      this.authStore = authStore ?? new MockAuthStore()
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

  return { state, MockPocketBase, MockAuthStore }
})

vi.mock('pocketbase', () => ({ default: h.MockPocketBase, BaseAuthStore: h.MockAuthStore }))

import { createPocketBaseBackend } from '../src/lib/api'
import type { C11nBackend } from '../src/lib/api'

function setup(baseUrl?: string) {
  const backend = baseUrl ? createPocketBaseBackend(baseUrl) : createPocketBaseBackend()
  const pb = h.state.instances[h.state.instances.length - 1]
  // The PB impl resolves project slugs to record ids via the projects
  // collection; give every test a default 'proj1' → 'pid1' mapping.
  pb.collection('projects').getFirstListItem.mockResolvedValue({ id: 'pid1', slug: 'proj1' })
  return { backend: backend as C11nBackend, pb }
}

/** Drain pending microtasks/timers so async subscribe setup completes. */
const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Make the backend believe the session cookie belongs to `user`. */
async function authenticate(backend: C11nBackend, user: unknown): Promise<void> {
  const u = user as { id: string; email: string; name: string }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ id: u.id, email: u.email, name: u.name, role: 'client' }),
      text: async () => '',
    })),
  )
  await backend.me()
}

const userRecord = { id: 'u1', email: 'alice@example.com', name: 'Alice' }

beforeEach(() => {
  h.state.reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
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

  it('constructs the SDK with an in-memory auth store (never localStorage)', () => {
    const { pb } = setup()
    expect(pb.authStore).toBeInstanceOf(h.MockAuthStore)
  })
})

describe('me / logout / invite (cookie identity, ADR 0006)', () => {
  /** Stub fetch with one canned response; returns the mock for assertions. */
  function stubFetch(status: number, body: unknown) {
    const fetchMock = vi.fn(async () => ({
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('me() reads the session route and maps the user including the role', async () => {
    const { backend } = setup()
    const fetchMock = stubFetch(200, {
      id: 'u1',
      email: 'tom@hfdf.io',
      name: 'Tom',
      role: 'team',
    })

    const me = await backend.me()

    expect(me).toEqual({ id: 'u1', email: 'tom@hfdf.io', name: 'Tom', role: 'team' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/__c11n/pb/api/c11n/me',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })

  it('me() falls back to the email when the record has no name', async () => {
    const { backend } = setup()
    stubFetch(200, { id: 'u2', email: 'bob@example.com', name: '', role: 'client' })

    expect((await backend.me())!.name).toBe('bob@example.com')
  })

  it('me() is null on 401 (an expired cookie), not an exception', async () => {
    const { backend } = setup()
    stubFetch(401, { message: 'not signed in' })

    await expect(backend.me()).resolves.toBeNull()
  })

  it('me() throws on a non-401 failure, so the store can tell them apart', async () => {
    const { backend } = setup()
    stubFetch(500, { message: 'boom' })

    await expect(backend.me()).rejects.toThrow('me failed (500)')
  })

  it('me() forgets the session when the cookie dies mid-session', async () => {
    const { backend } = setup()
    stubFetch(200, { id: 'u1', email: 'tom@hfdf.io', name: 'Tom', role: 'team' })
    await backend.me()

    stubFetch(401, {})
    await backend.me()

    // Writes must be refused now, not attributed to the stale user.
    await expect(
      backend.createComment({
        project: 'proj1',
        path: '/',
        selector: 'h1',
        anchorMeta: null,
        body: 'late',
      }),
    ).rejects.toThrow(/not signed in/)
  })

  it('logout() posts the public route, then leaves for the sign-in page', async () => {
    const { backend } = setup()
    const fetchMock = stubFetch(204, '')
    const assign = vi.fn()
    vi.stubGlobal('location', { assign })

    await backend.logout()

    expect(fetchMock).toHaveBeenCalledWith(
      '/__c11n/auth/logout',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
    )
    expect(assign).toHaveBeenCalledWith('/__c11n/auth/?reason=signed-out')
  })

  it('logout() still leaves when clearing the cookie fails', async () => {
    const { backend } = setup()
    const assign = vi.fn()
    vi.stubGlobal('location', { assign })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )

    await expect(backend.logout()).rejects.toThrow('offline')
    expect(assign).toHaveBeenCalledWith('/__c11n/auth/?reason=signed-out')
  })

  it('invite() posts email + role and returns the link', async () => {
    const { backend } = setup()
    const fetchMock = stubFetch(200, {
      link: 'http://127.0.0.1:18080/__c11n/auth/magic?t=abc',
      expiresAt: '2026-11-28T00:00:00.000Z',
    })

    const res = await backend.invite('new@example.com', 'client')

    expect(res.link).toContain('/__c11n/auth/magic?t=abc')
    expect(res.expiresAt).toBe('2026-11-28T00:00:00.000Z')
    expect(fetchMock).toHaveBeenCalledWith(
      '/__c11n/pb/api/c11n/invite',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({ email: 'new@example.com', role: 'client' }),
      }),
    )
  })

  it('invite() surfaces a 403 with the server message and status', async () => {
    const { backend } = setup()
    stubFetch(403, { message: 'team members can only invite clients' })

    const err = (await backend.invite('x@example.com', 'team').catch((e) => e)) as {
      status?: number
      message: string
    }
    expect(err.status).toBe(403)
    expect(err.message).toContain('team members can only invite clients')
  })

  it('invite() rejects a success response with no link', async () => {
    const { backend } = setup()
    stubFetch(200, {})
    await expect(backend.invite('x@example.com', 'client')).rejects.toThrow(/no link/i)
  })
})

describe('listComments', () => {
  it('resolves the project slug to a record id for the filter (relation field)', async () => {
    const { backend, pb } = setup()
    await backend.listComments('proj1', '/pricing')

    expect(pb.collection('projects').getFirstListItem).toHaveBeenCalledWith('slug = "proj1"')
    expect(pb.collection('comments').getFullList).toHaveBeenCalledWith({
      filter: 'project = "pid1" && path = "/pricing"',
      sort: 'created',
      expand: 'author',
    })
  })

  it('caches the slug → id lookup across calls', async () => {
    const { backend, pb } = setup()
    await backend.listComments('proj1', '/a')
    await backend.listComments('proj1', '/b')
    await backend.listComments('proj1')

    expect(pb.collection('projects').getFirstListItem).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failed lookup (e.g. before login) — retries next call', async () => {
    const { backend, pb } = setup()
    pb.collection('projects').getFirstListItem
      .mockRejectedValueOnce(new Error('401'))
      .mockResolvedValueOnce({ id: 'pid1', slug: 'proj1' })

    await expect(backend.listComments('proj1', '/a')).rejects.toThrow('401')
    await backend.listComments('proj1', '/a')

    expect(pb.collection('projects').getFirstListItem).toHaveBeenCalledTimes(2)
    expect(pb.collection('comments').getFullList).toHaveBeenCalledWith(
      expect.objectContaining({ filter: 'project = "pid1" && path = "/a"' }),
    )
  })

  it('omitting path queries project-wide (sidebar list) with the same sort/expand', async () => {
    const { backend, pb } = setup()
    await backend.listComments('proj1')

    expect(pb.collection('comments').getFullList).toHaveBeenCalledWith({
      filter: 'project = "pid1"',
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
        seq: 1,
        project: 'pid1',
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
        project: 'pid1',
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
        project: 'pid1',
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
        seq: 1,
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

  it('injects author, resolves the project slug to a record id, and maps the created record', async () => {
    const { backend, pb } = setup()
    await authenticate(backend, userRecord)
    pb.collection('comments').create.mockResolvedValue({
      id: 'c9',
      ...input,
      project: 'pid1',
      author: 'u1',
      resolved: false,
      created: 'x',
      updated: 'x',
      expand: { author: userRecord },
    })

    const rec = await backend.createComment(input)

    // The relation field gets the record id, NOT the slug the overlay sends —
    // sending the slug 400s against real PocketBase (missing_rel_records).
    // The create expands the author so the returned record carries the display
    // name itself: the realtime echo path backfills from the session, the HTTP
    // path must not need that crutch.
    expect(pb.collection('comments').create).toHaveBeenCalledWith(
      {
        ...input,
        project: 'pid1',
        author: 'u1',
      },
      { expand: 'author' },
    )
    expect(rec).toEqual(
      expect.objectContaining({
        id: 'c9',
        author: 'u1',
        body: 'hello',
        resolved: false,
        authorName: 'Alice',
      }),
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

    await authenticate(backend, userRecord)
    pb.collection('replies').create.mockResolvedValue({
      id: 'r2',
      comment: 'c1',
      body: 'hi',
      author: 'u1',
      created: 'x',
      expand: { author: userRecord },
    })

    const rec = await backend.createReply('c1', 'hi')
    // Expanded like createComment: the create response carries the name.
    expect(pb.collection('replies').create).toHaveBeenCalledWith(
      {
        comment: 'c1',
        body: 'hi',
        author: 'u1',
      },
      { expand: 'author' },
    )
    expect(rec).toEqual({
      id: 'r2',
      comment: 'c1',
      body: 'hi',
      author: 'u1',
      authorName: 'Alice',
      created: 'x',
    })
  })
})

describe('subscribe', () => {
  // Realtime events deliver the stored record, whose project is the record id.
  const commentRecord = {
    id: 'c1',
    project: 'pid1',
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

  async function wire() {
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
    await flushAsync() // slug → id lookup happens before the SDK subscribe
    const commentCb = pb.collection('comments').subscribe.mock.calls[0][1]
    const replyCb = pb.collection('replies').subscribe.mock.calls[0][1]
    return { backend, pb, handlers, unsubscribe, commentCb, replyCb }
  }

  it('scopes both collections to the resolved project id (S3: replies via the comment relation)', async () => {
    const { pb } = await wire()

    expect(pb.collection('comments').subscribe).toHaveBeenCalledWith(
      '*',
      expect.any(Function),
      { filter: 'project = "pid1"' },
    )
    // `replies` has no project field; the project lives on the parent comment.
    // Without this filter every authenticated subscriber receives every reply
    // on the server, whatever project it belongs to.
    expect(pb.collection('replies').subscribe).toHaveBeenCalledWith(
      '*',
      expect.any(Function),
      { filter: 'comment.project = "pid1"' },
    )
  })

  it('unsubscribing before the project lookup lands cancels the subscribe', async () => {
    const { backend, pb } = setup()
    let release!: (v: unknown) => void
    pb.collection('projects').getFirstListItem.mockReturnValue(
      new Promise((resolve) => (release = resolve)),
    )

    const unsubscribe = backend.subscribe('proj1', {})
    unsubscribe()
    release({ id: 'pid1', slug: 'proj1' })
    await flushAsync()

    expect(pb.collection('comments').subscribe).not.toHaveBeenCalled()
    expect(pb.collection('replies').subscribe).not.toHaveBeenCalled()
  })

  it('dispatches comment events to the matching handlers with mapped records', async () => {
    const { handlers, commentCb } = await wire()

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

  it('ignores comment events from other projects (client-side belt and braces)', async () => {
    const { handlers, commentCb } = await wire()
    commentCb({ action: 'create', record: { ...commentRecord, project: 'other-id' } })
    expect(handlers.onCommentCreate).not.toHaveBeenCalled()
  })

  it('dispatches reply events to the matching handlers', async () => {
    const { handlers, replyCb } = await wire()

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

  it('tolerates missing handlers', async () => {
    const { backend, pb } = setup()
    backend.subscribe('proj1', {})
    await flushAsync()
    const commentCb = pb.collection('comments').subscribe.mock.calls[0][1]
    expect(() => commentCb({ action: 'create', record: commentRecord })).not.toThrow()
  })

  it('returned function unsubscribes both collections', async () => {
    const { pb, unsubscribe } = await wire()
    unsubscribe()
    expect(pb.collection('comments').unsubscribe).toHaveBeenCalledWith('*')
    expect(pb.collection('replies').unsubscribe).toHaveBeenCalledWith('*')
  })
})

describe('M-4 a 401 from any call sends the user to sign-in', () => {
  /** jsdom-less location stub: goToSignIn reads pathname/search and assigns. */
  function stubLocation() {
    const assign = vi.fn()
    vi.stubGlobal('location', { assign, pathname: '/pricing', search: '?x=1' })
    return assign
  }

  it('a write that 401s navigates to the sign-in page instead of throwing silently', async () => {
    const { backend, pb } = setup()
    await authenticate(backend, userRecord)
    const assign = stubLocation()
    pb.collection('comments').create.mockRejectedValue({ status: 401 })

    await expect(
      backend.createComment({
        project: 'proj1',
        path: '/pricing',
        selector: 'h1',
        anchorMeta: null,
        body: 'after logout',
      }),
    ).rejects.toBeTruthy()

    expect(assign).toHaveBeenCalledWith(
      `/__c11n/auth/?reason=expired&next=${encodeURIComponent('/pricing?x=1')}`,
    )
  })

  it('a read that 401s (listComments) does the same', async () => {
    const { backend, pb } = setup()
    await authenticate(backend, userRecord)
    const assign = stubLocation()
    pb.collection('comments').getFullList.mockRejectedValue({ status: 401 })

    await expect(backend.listComments('proj1', '/pricing')).rejects.toBeTruthy()
    expect(assign).toHaveBeenCalledTimes(1)
  })

  it('navigates only once for repeated 401s', async () => {
    const { backend, pb } = setup()
    await authenticate(backend, userRecord)
    const assign = stubLocation()
    pb.collection('comments').update.mockRejectedValue({ status: 401 })
    pb.collection('comments').delete.mockRejectedValue({ status: 401 })

    await expect(backend.setResolved('c1', true)).rejects.toBeTruthy()
    await expect(backend.deleteComment('c1')).rejects.toBeTruthy()
    expect(assign).toHaveBeenCalledTimes(1)
  })

  it('a non-401 failure does not navigate (a 403 is a permission error, not a dead session)', async () => {
    const { backend, pb } = setup()
    await authenticate(backend, userRecord)
    const assign = stubLocation()
    pb.collection('comments').delete.mockRejectedValue({ status: 403 })

    await expect(backend.deleteComment('c1')).rejects.toBeTruthy()
    expect(assign).not.toHaveBeenCalled()
  })
})
