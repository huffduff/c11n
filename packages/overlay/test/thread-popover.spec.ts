import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { computePosition } from '@floating-ui/dom'
import { setBackend } from '../src/lib/backend'
import type { C11nBackend, CommentRec, ReplyRec } from '../src/lib/api'
import { PROJECT } from '../src/lib/project'
import { useCommentsStore } from '../src/stores/comments'
import ThreadPopover from '../src/components/ThreadPopover.vue'

vi.mock('@floating-ui/dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@floating-ui/dom')>()
  return {
    ...actual,
    computePosition: vi.fn().mockResolvedValue({ x: 12, y: 34 }),
  }
})

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

function reply(overrides: Partial<ReplyRec> = {}): ReplyRec {
  return {
    id: 'r1',
    comment: 'c1',
    body: 'Agreed, way too much',
    author: 'u2',
    authorName: 'Ana',
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
    listReplies: vi.fn().mockResolvedValue([reply()]),
    createReply: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  }
}

async function flush(wrapper: VueWrapper) {
  await wrapper.vm.$nextTick()
  await Promise.resolve()
  await wrapper.vm.$nextTick()
}

describe('ThreadPopover.vue', () => {
  let pinia: Pinia
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    document.body.innerHTML = '<div id="alpha">Alpha section</div>'
    setActivePinia((pinia = createPinia()))
    vi.mocked(computePosition).mockClear()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  async function mountPopover(comment = rec(), backend: Partial<C11nBackend> = {}) {
    const mock = makeMockBackend(backend)
    setBackend(mock)
    const store = useCommentsStore()
    store.currentPath = comment.path
    store.items = [comment]
    store.openThread(comment.id)
    wrapper = mount(ThreadPopover, { global: { plugins: [pinia] } })
    await flush(wrapper)
    return { store, mock, wrapper }
  }

  it('renders comment body, author name, and created date', async () => {
    const { wrapper } = await mountPopover()

    expect(wrapper.find('.c11n-popover-body').text()).toBe('Too expensive')
    expect(wrapper.find('.c11n-popover-author').text()).toBe('Tom')
    expect(wrapper.find('.c11n-popover-date').text()).not.toBe('')
  })

  it('renders seq number in header when present', async () => {
    const { wrapper } = await mountPopover(rec({ seq: 7 }))
    const seq = wrapper.find('.c11n-popover-seq')
    expect(seq.exists()).toBe(true)
    expect(seq.text()).toBe('#7')
  })

  it("falls back to 'author' when authorName is missing", async () => {
    const { wrapper } = await mountPopover(rec({ authorName: undefined }))

    expect(wrapper.find('.c11n-popover-author').text()).toBe('author')
  })

  it('loads replies on open and renders them', async () => {
    const { mock, wrapper } = await mountPopover()

    expect(mock.listReplies).toHaveBeenCalledWith('c1')
    const items = wrapper.findAll('.c11n-popover-reply')
    expect(items).toHaveLength(1)
    expect(items[0].text()).toContain('Ana')
    expect(items[0].text()).toContain('Agreed, way too much')
  })

  it('submits a reply through the backend and appends it to the thread', async () => {
    const newReply = reply({ id: 'r2', body: 'Sounds good', authorName: 'Tom' })
    const { mock, wrapper } = await mountPopover(rec(), {
      createReply: vi.fn().mockResolvedValue(newReply),
    })

    await wrapper.find('.c11n-popover-reply-text').setValue('Sounds good')
    await wrapper.find('.c11n-reply-submit').trigger('click')
    await flush(wrapper)

    expect(mock.createReply).toHaveBeenCalledWith('c1', 'Sounds good')
    const items = wrapper.findAll('.c11n-popover-reply')
    expect(items).toHaveLength(2)
    expect(items[1].text()).toContain('Sounds good')
    // textarea cleared after a successful submit
    expect((wrapper.find('.c11n-popover-reply-text').element as HTMLTextAreaElement).value).toBe('')
  })

  it('disables reply submit while empty and while the store is loading', async () => {
    const { store, wrapper } = await mountPopover()

    expect(wrapper.find('.c11n-reply-submit').attributes('disabled')).toBeDefined()

    await wrapper.find('.c11n-popover-reply-text').setValue('text')
    expect(wrapper.find('.c11n-reply-submit').attributes('disabled')).toBeUndefined()

    store.loading = true
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.c11n-reply-submit').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.c11n-popover-reply-text').attributes('disabled')).toBeDefined()
  })

  it('Resolve marks the comment resolved and closes the thread', async () => {
    const { store, mock, wrapper } = await mountPopover()

    await wrapper.find('.c11n-popover-resolve').trigger('click')
    await flush(wrapper)

    expect(mock.setResolved).toHaveBeenCalledWith('c1', true)
    expect(store.items[0].resolved).toBe(true)
    expect(store.activeCommentId).toBeNull()
  })

  it('× closes the thread', async () => {
    const { store, wrapper } = await mountPopover()

    await wrapper.find('.c11n-popover-close').trigger('click')

    expect(store.activeCommentId).toBeNull()
  })

  it('positions against the anchored element via computePosition (fixed strategy)', async () => {
    await mountPopover()

    expect(computePosition).toHaveBeenCalledTimes(1)
    const [reference, , opts] = vi.mocked(computePosition).mock.calls[0]
    expect(reference).toBe(document.querySelector('#alpha'))
    expect(opts?.strategy).toBe('fixed')
  })

  it('skips positioning when the anchor no longer resolves', async () => {
    await mountPopover(rec({ selector: '#gone', anchorMeta: null }))

    expect(computePosition).not.toHaveBeenCalled()
  })
})
