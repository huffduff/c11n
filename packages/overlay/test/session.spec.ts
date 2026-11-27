import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// The store navigates on a 401; jsdom cannot navigate, so the redirect is
// asserted through this mock rather than by observing location.
vi.mock('../src/lib/signin', () => ({
  signInUrl: (reason: string, next?: string) =>
    `/__c11n/auth/?reason=${reason}${next ? `&next=${encodeURIComponent(next)}` : ''}`,
  goToSignIn: vi.fn(),
}))

import { goToSignIn } from '../src/lib/signin'
import { setBackend } from '../src/lib/backend'
import type { C11nBackend, Me } from '../src/lib/api'
import { useSessionStore } from '../src/stores/session'

const tom: Me = { id: 'u1', email: 'tom@hfdf.io', name: 'Tom', role: 'team' }

function makeMockBackend(overrides: Partial<C11nBackend> = {}): C11nBackend {
  return {
    me: vi.fn().mockResolvedValue(null),
    logout: vi.fn().mockResolvedValue(undefined),
    invite: vi.fn(),
    listComments: vi.fn().mockResolvedValue([]),
    createComment: vi.fn(),
    setResolved: vi.fn().mockResolvedValue(undefined),
    deleteComment: vi.fn().mockResolvedValue(undefined),
    listReplies: vi.fn().mockResolvedValue([]),
    createReply: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  }
}

describe('useSessionStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(goToSignIn).mockClear()
  })

  it('starts signed out', () => {
    setBackend(makeMockBackend())
    const store = useSessionStore()
    expect(store.me).toBeNull()
    expect(store.isAuthed).toBe(false)
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('init() asks the proxy who the cookie belongs to', async () => {
    setBackend(makeMockBackend({ me: vi.fn().mockResolvedValue(tom) }))
    const store = useSessionStore()

    await store.init()

    expect(store.me).toEqual(tom)
    expect(store.isAuthed).toBe(true)
    expect(store.loading).toBe(false)
    expect(goToSignIn).not.toHaveBeenCalled()
  })

  it('init() sends a 401 (expired cookie) to the sign-in page', async () => {
    setBackend(makeMockBackend({ me: vi.fn().mockResolvedValue(null) }))
    const store = useSessionStore()

    await store.init()

    expect(store.me).toBeNull()
    expect(store.isAuthed).toBe(false)
    expect(store.loading).toBe(false)
    expect(goToSignIn).toHaveBeenCalledWith('expired')
  })

  it('init() does not redirect on a network failure (it is not "signed out")', async () => {
    setBackend(makeMockBackend({ me: vi.fn().mockRejectedValue(new Error('offline')) }))
    const store = useSessionStore()

    await store.init()

    expect(store.me).toBeNull()
    expect(store.loading).toBe(false)
    expect(goToSignIn).not.toHaveBeenCalled()
  })

  it('logout() awaits the backend and drops the local session', async () => {
    const mock = makeMockBackend({ me: vi.fn().mockResolvedValue(tom) })
    setBackend(mock)
    const store = useSessionStore()
    await store.init()
    expect(store.me).toEqual(tom)

    await store.logout()

    expect(mock.logout).toHaveBeenCalled()
    expect(store.me).toBeNull()
    expect(store.isAuthed).toBe(false)
  })

  it('logout() drops the local session even when clearing the cookie throws', async () => {
    const mock = makeMockBackend({
      me: vi.fn().mockResolvedValue(tom),
      logout: vi.fn().mockRejectedValue(new Error('network')),
    })
    setBackend(mock)
    const store = useSessionStore()
    await store.init()

    await expect(store.logout()).rejects.toThrow('network')
    expect(store.me).toBeNull()
  })
})
