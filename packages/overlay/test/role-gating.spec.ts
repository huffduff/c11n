import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { setBackend } from '../src/lib/backend'
import type { C11nBackend, CommentRec, Role } from '../src/lib/api'
import { canComment, canDelete, canResolve } from '../src/lib/permissions'
import { PROJECT } from '../src/lib/project'
import { useCommentsStore } from '../src/stores/comments'
import { useSessionStore } from '../src/stores/session'
import ThreadPopover from '../src/components/ThreadPopover.vue'
import Sidebar from '../src/components/Sidebar.vue'
import Toolbar from '../src/components/Toolbar.vue'

/**
 * The overlay half of the ADR 0008 matrix (task 3.10). The backend enforces
 * every cell on its own (e2e/specs/permissions-matrix.spec.ts); these tests
 * pin what the UI offers, because a hidden button is the difference between a
 * 404 the reviewer caused and a 404 they read.
 */

function rec(overrides: Partial<CommentRec> = {}): CommentRec {
  return {
    id: 'c1',
    project: PROJECT,
    path: '/pricing',
    selector: '#alpha',
    anchorMeta: { tag: 'div', text: 'Alpha section', rect: { x: 0, y: 0, width: 10, height: 10 } },
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
    invite: vi.fn(),
    logout: vi.fn(),
    me: vi.fn().mockReturnValue(null),
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

describe('permissions helpers (ADR 0008)', () => {
  it('only the agent cannot open a top-level comment', () => {
    expect(canComment('owner')).toBe(true)
    expect(canComment('team')).toBe(true)
    expect(canComment('client')).toBe(true)
    expect(canComment('agent')).toBe(false)
    // An unknown role is no role: never assume a capability.
    expect(canComment(undefined)).toBe(false)
  })

  it('owner and team resolve any thread, a client only its own, an agent never', () => {
    for (const role of ['owner', 'team'] as Role[]) {
      expect(canResolve(role, false)).toBe(true)
      expect(canResolve(role, true)).toBe(true)
    }
    expect(canResolve('client', true)).toBe(true)
    expect(canResolve('client', false)).toBe(false)
    expect(canResolve('agent', true)).toBe(false)
    expect(canResolve('agent', false)).toBe(false)
    expect(canResolve(undefined, true)).toBe(false)
  })

  it('anyone may delete own content; deleting anyone else is the owner alone', () => {
    expect(canDelete('owner', false)).toBe(true)
    for (const role of ['team', 'client', 'agent'] as Role[]) {
      expect(canDelete(role, true)).toBe(true)
      expect(canDelete(role, false)).toBe(false)
    }
    expect(canDelete(undefined, true)).toBe(false)
  })
})

describe('overlay role gating', () => {
  let pinia: Pinia
  const mounted: VueWrapper[] = []

  beforeEach(() => {
    document.body.innerHTML = '<div id="alpha">Alpha section</div>'
    setActivePinia((pinia = createPinia()))
  })

  afterEach(() => {
    for (const w of mounted.splice(0)) w.unmount()
  })

  function signInAs(role: Role, id = 'me'): void {
    useSessionStore().me = { id, email: `${role}@c11n.test`, name: role, role }
  }

  async function mountPopover(comment: CommentRec, role: Role, id = 'me') {
    const backend = makeMockBackend()
    setBackend(backend)
    signInAs(role, id)
    const store = useCommentsStore()
    store.currentPath = comment.path
    store.items = [comment]
    store.openThread(comment.id)
    const wrapper = mount(ThreadPopover, { global: { plugins: [pinia] } })
    mounted.push(wrapper)
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    await wrapper.vm.$nextTick()
    return { wrapper, store, backend }
  }

  it('hides the comment-mode toggle from the agent', () => {
    signInAs('agent')
    setBackend(makeMockBackend())
    const wrapper = mount(Toolbar, { global: { plugins: [pinia] } })
    mounted.push(wrapper)
    expect(wrapper.find('.c11n-mode-toggle').exists()).toBe(false)
    expect(wrapper.find('.c11n-sidebar-toggle').exists()).toBe(true)
  })

  it('a client gets no Resolve on a thread it did not author', async () => {
    const { wrapper } = await mountPopover(rec({ author: 'someone-else' }), 'client')
    expect(wrapper.find('.c11n-popover-resolve').exists()).toBe(false)
    expect(wrapper.find('.c11n-popover-reopen').exists()).toBe(false)
  })

  it('a client gets Resolve on its own thread', async () => {
    const { wrapper } = await mountPopover(rec({ author: 'me' }), 'client')
    expect(wrapper.find('.c11n-popover-resolve').exists()).toBe(true)
  })

  it('team gets Resolve on someone else’s thread', async () => {
    const { wrapper } = await mountPopover(rec({ author: 'someone-else' }), 'team')
    expect(wrapper.find('.c11n-popover-resolve').exists()).toBe(true)
  })

  it('the agent gets neither Resolve nor Reopen', async () => {
    const open = await mountPopover(rec({ author: 'someone-else' }), 'agent')
    expect(open.wrapper.find('.c11n-popover-resolve').exists()).toBe(false)
    const closed = await mountPopover(rec({ id: 'c2', author: 'someone-else', resolved: true }), 'agent')
    expect(closed.wrapper.find('.c11n-popover-reopen').exists()).toBe(false)
  })

  it('team can reopen a resolved thread', async () => {
    const { wrapper, backend, store } = await mountPopover(
      rec({ author: 'someone-else', resolved: true }),
      'team',
    )
    expect(wrapper.find('.c11n-popover-resolve').exists()).toBe(false)
    const reopen = wrapper.find('.c11n-popover-reopen')
    expect(reopen.exists()).toBe(true)
    await reopen.trigger('click')
    expect(backend.setResolved).toHaveBeenCalledWith('c1', false)
    expect(store.items[0].resolved).toBe(false)
  })

  it('the owner gets Delete on someone else’s comment and it deletes it', async () => {
    const { wrapper, backend, store } = await mountPopover(rec({ author: 'someone-else' }), 'owner')
    const del = wrapper.find('.c11n-popover-delete')
    expect(del.exists()).toBe(true)
    await del.trigger('click')
    expect(backend.deleteComment).toHaveBeenCalledWith('c1')
    expect(store.items).toHaveLength(0)
    expect(store.activeCommentId).toBeNull()
  })

  it('an author gets Delete on its own comment, a client does not on another’s', async () => {
    const own = await mountPopover(rec({ author: 'me' }), 'client')
    expect(own.wrapper.find('.c11n-popover-delete').exists()).toBe(true)

    const other = await mountPopover(rec({ id: 'c2', author: 'someone-else' }), 'client')
    expect(other.wrapper.find('.c11n-popover-delete').exists()).toBe(false)
  })

  it('team sees Reopen in the sidebar’s Resolved tab; a client on another’s thread does not', async () => {
    const resolved = rec({ id: 'r1', author: 'someone-else', resolved: true })
    const backend = makeMockBackend()
    setBackend(backend)
    signInAs('team')
    const store = useCommentsStore()
    store.currentPath = resolved.path
    store.sidebarComments = [resolved]
    const wrapper = mount(Sidebar, { global: { plugins: [pinia] } })
    mounted.push(wrapper)
    await wrapper.findAll('.c11n-sidebar-tab')[1].trigger('click')
    const reopen = wrapper.find('.c11n-sidebar-reopen')
    expect(reopen.exists()).toBe(true)
    await reopen.trigger('click')
    expect(backend.setResolved).toHaveBeenCalledWith('r1', false)
    expect(store.sidebarComments[0].resolved).toBe(false)

    const clientBackend = makeMockBackend()
    setBackend(clientBackend)
    signInAs('client')
    const clientStore = useCommentsStore()
    clientStore.currentPath = resolved.path
    clientStore.sidebarComments = [{ ...resolved, id: 'r2' }]
    const clientSidebar = mount(Sidebar, { global: { plugins: [pinia] } })
    mounted.push(clientSidebar)
    await clientSidebar.findAll('.c11n-sidebar-tab')[1].trigger('click')
    expect(clientSidebar.find('.c11n-sidebar-reopen').exists()).toBe(false)
  })
})
