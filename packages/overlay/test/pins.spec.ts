import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { setBackend } from '../src/lib/backend'
import type { C11nBackend, CommentRec } from '../src/lib/api'
import { PROJECT } from '../src/lib/project'
import { useCommentsStore } from '../src/stores/comments'
import PinLayer from '../src/components/PinLayer.vue'

function rec(overrides: Partial<CommentRec> = {}): CommentRec {
  return {
    id: 'c1',
    project: PROJECT,
    path: '/pricing',
    selector: '#alpha',
    anchorMeta: {
      tag: 'div',
      text: 'Alpha section',
      rect: { x: 0, y: 0, width: 10, height: 10 },
    },
    body: 'Comment',
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
    createComment: vi.fn(),
    setResolved: vi.fn().mockResolvedValue(undefined),
    listReplies: vi.fn().mockResolvedValue([]),
    createReply: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  }
}

const c1 = () => rec({ id: 'c1', selector: '#alpha', created: '2026-08-19 10:00:00' })
const c2 = () =>
  rec({
    id: 'c2',
    selector: '#beta',
    anchorMeta: { tag: 'p', text: 'Beta text', rect: { x: 0, y: 0, width: 10, height: 10 } },
    created: '2026-08-19 09:00:00',
  })
const orphan = () =>
  rec({
    id: 'c3',
    selector: '#missing',
    anchorMeta: { tag: 'span', text: 'Nowhere to be found', rect: { x: 0, y: 0, width: 1, height: 1 } },
    created: '2026-08-19 11:00:00',
  })

function seedDom() {
  document.body.innerHTML =
    '<div id="alpha">Alpha section</div><p id="beta">Beta text</p>'
}

function seedStore(items: CommentRec[]) {
  const store = useCommentsStore()
  store.currentPath = '/pricing'
  store.items = items
  return store
}

describe('comments store resolvePins', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setBackend(makeMockBackend())
    seedDom()
  })

  it('classifies resolvable comments as pinned (created asc) and dead anchors as orphaned', () => {
    const store = seedStore([c1(), c2(), orphan()])

    const { pinned, orphaned } = store.resolvePins()

    // c2 was created before c1 → stable numbering order is c2, c1
    expect(pinned.map((p) => p.comment.id)).toEqual(['c2', 'c1'])
    expect(pinned[0].el).toBe(document.querySelector('#beta'))
    expect(pinned[1].el).toBe(document.querySelector('#alpha'))
    expect(orphaned.map((c) => c.id)).toEqual(['c3'])
  })

  it('exposes orphans on state for the sidebar (Task 12)', () => {
    const store = seedStore([c1(), orphan()])

    store.resolvePins()

    expect(store.orphans.map((c) => c.id)).toEqual(['c3'])
  })

  it('excludes resolved comments entirely', () => {
    const store = seedStore([
      c1(),
      rec({ id: 'c4', resolved: true }),
      rec({ id: 'c5', selector: '#missing', resolved: true }),
    ])

    const { pinned, orphaned } = store.resolvePins()

    expect(pinned.map((p) => p.comment.id)).toEqual(['c1'])
    expect(orphaned).toEqual([])
  })

  it('excludes comments from other paths', () => {
    const store = seedStore([c1(), rec({ id: 'c9', path: '/about' })])

    const { pinned } = store.resolvePins()

    expect(pinned.map((p) => p.comment.id)).toEqual(['c1'])
  })

  it('a comment with neither selector nor anchorMeta is neither pinned nor orphaned', () => {
    const store = seedStore([rec({ id: 'bare', selector: '', anchorMeta: null })])

    const { pinned, orphaned } = store.resolvePins()

    expect(pinned).toEqual([])
    expect(orphaned).toEqual([])
  })

  it('a comment with only a selector (null anchorMeta) can still pin via querySelector', () => {
    const store = seedStore([rec({ id: 'sel-only', anchorMeta: null })])

    const { pinned } = store.resolvePins()

    expect(pinned.map((p) => p.comment.id)).toEqual(['sel-only'])
    expect(pinned[0].el).toBe(document.querySelector('#alpha'))
  })
})

describe('PinLayer.vue', () => {
  let pinia: Pinia
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    // Synchronous rAF: tracker recomputes immediately → pins get inline styles.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    setActivePinia((pinia = createPinia()))
    setBackend(makeMockBackend())
    seedDom()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    vi.unstubAllGlobals()
  })

  function mountLayer(items: CommentRec[]) {
    const store = seedStore(items)
    wrapper = mount(PinLayer, { global: { plugins: [pinia] } })
    return { store, wrapper }
  }

  it('renders one numbered pin button per pinned comment, none for orphans', () => {
    const { wrapper } = mountLayer([c1(), c2(), orphan()])

    const pins = wrapper.findAll('.c11n-pin')
    expect(pins).toHaveLength(2)
    expect(pins.map((p) => p.text())).toEqual(['1', '2'])
  })

  it('positions pins from tracker rects (inline fixed left/top)', () => {
    const { wrapper } = mountLayer([c1()])

    const style = wrapper.find('.c11n-pin').attributes('style') ?? ''
    // jsdom rects are all zeros → right+4 / top-4
    expect(style).toContain('left: 4px')
    expect(style).toContain('top: -4px')
  })

  it('clicking a pin opens its thread', async () => {
    const { store, wrapper } = mountLayer([c1(), c2()])
    const openSpy = vi.spyOn(store, 'openThread')

    // pin #1 is c2 (earlier created)
    await wrapper.findAll('.c11n-pin')[0].trigger('click')
    expect(openSpy).toHaveBeenCalledWith('c2')

    await wrapper.findAll('.c11n-pin')[1].trigger('click')
    expect(openSpy).toHaveBeenCalledWith('c1')
  })

  it('drops the pin reactively when its comment is resolved in place', async () => {
    const { store, wrapper } = mountLayer([c1(), c2()])
    expect(wrapper.findAll('.c11n-pin')).toHaveLength(2)

    store.items.find((c) => c.id === 'c1')!.resolved = true
    await nextTick()
    await nextTick()

    expect(wrapper.findAll('.c11n-pin')).toHaveLength(1)
    expect(wrapper.find('.c11n-pin').text()).toBe('1')
  })

  it('re-resolves when the path changes', async () => {
    const { store, wrapper } = mountLayer([c1(), c2()])
    expect(wrapper.findAll('.c11n-pin')).toHaveLength(2)

    store.currentPath = '/about'
    await nextTick()
    await nextTick()

    expect(wrapper.findAll('.c11n-pin')).toHaveLength(0)
  })
})
