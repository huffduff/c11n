import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setBackend } from '../src/lib/backend'
import type { C11nBackend, Me } from '../src/lib/api'
import { useSessionStore } from '../src/stores/session'

const tom: Me = { id: 'u1', email: 'tom@hfdf.io', name: 'Tom' }

function makeMockBackend(overrides: Partial<C11nBackend> = {}): C11nBackend {
  return {
    login: vi.fn().mockResolvedValue(tom),
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

describe('useSessionStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('starts logged out', () => {
    setBackend(makeMockBackend())
    const store = useSessionStore()
    expect(store.me).toBeNull()
    expect(store.isAuthed).toBe(false)
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('init() restores a persisted session from backend.me()', () => {
    setBackend(makeMockBackend({ me: vi.fn().mockReturnValue(tom) }))
    const store = useSessionStore()
    store.init()
    expect(store.me).toEqual(tom)
    expect(store.isAuthed).toBe(true)
  })

  it('init() leaves me null when nothing is persisted', () => {
    setBackend(makeMockBackend())
    const store = useSessionStore()
    store.init()
    expect(store.me).toBeNull()
    expect(store.isAuthed).toBe(false)
  })

  it('login() success sets me and clears a previous error', async () => {
    const mock = makeMockBackend()
    setBackend(mock)
    const store = useSessionStore()
    store.error = 'Invalid email or password'

    await store.login('tom@hfdf.io', 'hunter2')

    expect(mock.login).toHaveBeenCalledWith('tom@hfdf.io', 'hunter2')
    expect(store.me).toEqual(tom)
    expect(store.isAuthed).toBe(true)
    expect(store.error).toBeNull()
    expect(store.loading).toBe(false)
  })

  it('login() sets loading while in flight', async () => {
    let resolveLogin!: (m: Me) => void
    const mock = makeMockBackend({
      login: vi.fn().mockReturnValue(new Promise<Me>((res) => (resolveLogin = res))),
    })
    setBackend(mock)
    const store = useSessionStore()

    const p = store.login('tom@hfdf.io', 'hunter2')
    expect(store.loading).toBe(true)
    resolveLogin(tom)
    await p
    expect(store.loading).toBe(false)
  })

  it('login() failure with status 400 sets a friendly error, me stays null', async () => {
    const mock = makeMockBackend({
      login: vi.fn().mockRejectedValue({ status: 400 }),
    })
    setBackend(mock)
    const store = useSessionStore()

    await store.login('tom@hfdf.io', 'wrong')

    expect(store.error).toBe('Invalid email or password')
    expect(store.me).toBeNull()
    expect(store.isAuthed).toBe(false)
    expect(store.loading).toBe(false)
  })

  it('login() failure with any other error sets a generic message', async () => {
    const mock = makeMockBackend({
      login: vi.fn().mockRejectedValue(new Error('network down')),
    })
    setBackend(mock)
    const store = useSessionStore()

    await store.login('tom@hfdf.io', 'hunter2')

    expect(store.error).toBe('Sign-in failed, please try again')
    expect(store.me).toBeNull()
    expect(store.loading).toBe(false)
  })

  it('logout() calls backend.logout and clears me', async () => {
    const mock = makeMockBackend()
    setBackend(mock)
    const store = useSessionStore()
    await store.login('tom@hfdf.io', 'hunter2')
    expect(store.me).toEqual(tom)

    store.logout()

    expect(mock.logout).toHaveBeenCalled()
    expect(store.me).toBeNull()
    expect(store.isAuthed).toBe(false)
  })
})
