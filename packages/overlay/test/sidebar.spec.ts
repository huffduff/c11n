import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { setBackend } from '../src/lib/backend'
import type { C11nBackend, CommentRec } from '../src/lib/api'
import { PROJECT } from '../src/lib/project'
import { useCommentsStore } from '../src/stores/comments'
import Sidebar from '../src/components/Sidebar.vue'

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

describe('Sidebar.vue', () => {
  let pinia: Pinia
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    document.body.innerHTML = '<div id="alpha">Alpha section</div>'
    setActivePinia((pinia = createPinia()))
    setBackend(makeMockBackend())
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  function mountSidebar(sidebarComments: CommentRec[], currentPath = '/pricing') {
    const store = useCommentsStore()
    store.currentPath = currentPath
    store.sidebarOpen = true
    store.sidebarComments = sidebarComments
    wrapper = mount(Sidebar, { global: { plugins: [pinia] } })
    return { store, wrapper }
  }

  it('shows a loading state while the project-wide list is loading', () => {
    const { store, wrapper } = mountSidebar([])
    store.sidebarLoading = true

    return wrapper.vm.$nextTick().then(() => {
      expect(wrapper.find('.c11n-sidebar-loading').exists()).toBe(true)
      expect(wrapper.findAll('.c11n-sidebar-row')).toHaveLength(0)
    })
  })

  it('defaults to the Unresolved tab and filters out resolved comments', () => {
    const { wrapper } = mountSidebar([
      rec({ id: 'u-1', body: 'open one' }),
      rec({ id: 'r-1', body: 'done one', resolved: true }),
    ])

    const rows = wrapper.findAll('.c11n-sidebar-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('open one')
  })

  it('the Resolved tab shows only resolved comments', async () => {
    const { wrapper } = mountSidebar([
      rec({ id: 'u-1', body: 'open one' }),
      rec({ id: 'r-1', body: 'done one', resolved: true }),
    ])

    const tabs = wrapper.findAll('.c11n-sidebar-tab')
    expect(tabs).toHaveLength(2)
    await tabs[1].trigger('click')

    const rows = wrapper.findAll('.c11n-sidebar-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('done one')
    expect(tabs[1].attributes('aria-selected')).toBe('true')
  })

  it("groups by path with the current page first, labeled 'This page'", () => {
    // /about sorts before /pricing alphabetically — current page must still win.
    const { wrapper } = mountSidebar([
      rec({ id: 'c-about', path: '/about', body: 'about page note' }),
      rec({ id: 'c-here', path: '/pricing', body: 'pricing note' }),
    ])

    const labels = wrapper.findAll('.c11n-sidebar-group-label').map((n) => n.text())
    expect(labels).toEqual(['This page', '/about'])
    const groups = wrapper.findAll('.c11n-sidebar-group')
    expect(groups[0].text()).toContain('pricing note')
    expect(groups[1].text()).toContain('about page note')
  })

  it('renders author fallback, date, and truncates long bodies', () => {
    const longBody = 'x'.repeat(120)
    const { wrapper } = mountSidebar([
      rec({ id: 'c-long', body: longBody, authorName: undefined }),
    ])

    const row = wrapper.find('.c11n-sidebar-row')
    expect(row.find('.c11n-sidebar-row-body').text().length).toBeLessThanOrEqual(81)
    expect(row.find('.c11n-sidebar-row-author').text()).toBe('author')
    expect(row.find('.c11n-sidebar-row-date').text()).not.toBe('')
  })

  it('flags orphaned current-page comments, never rows from other paths', () => {
    const orphan = rec({ id: 'c-orphan', selector: '#gone', body: 'lost anchor' })
    const other = rec({ id: 'c-orphan', path: '/about', selector: '#gone', body: 'same id elsewhere' })
    const { store, wrapper } = mountSidebar([orphan, other])
    store.orphans = [orphan]

    return wrapper.vm.$nextTick().then(() => {
      const flags = wrapper.findAll('.c11n-orphan-flag')
      expect(flags).toHaveLength(1)
      expect(flags[0].text()).toContain('element not found')
      const groups = wrapper.findAll('.c11n-sidebar-group')
      expect(groups[0].find('.c11n-orphan-flag').exists()).toBe(true) // This page
      expect(groups[1].find('.c11n-orphan-flag').exists()).toBe(false) // /about
    })
  })

  it('clicking a same-page row opens the thread and flashes the element', async () => {
    const { store, wrapper } = mountSidebar([rec({ id: 'c-here' })])

    await wrapper.find('.c11n-sidebar-row').trigger('click')

    expect(store.activeCommentId).toBe('c-here')
    const el = document.querySelector('#alpha')!
    expect(el.classList.contains('c11n-flash')).toBe(true)
  })

  it('renders seq number in sidebar row when present', () => {
    const { wrapper } = mountSidebar([rec({ id: 'c-seq', seq: 17, body: 'a sequenced comment' })])
    const seq = wrapper.find('.c11n-sidebar-row-seq')
    expect(seq.exists()).toBe(true)
    expect(seq.text()).toBe('#17')
  })

  // Review fix (Task 12 blocker): rapid double-click must never leave the
  // flash outline behind permanently on the reviewed page.
  it('double-clicking a row restores the original outline after the flash', async () => {
    vi.useFakeTimers()
    try {
      const el = document.querySelector('#alpha') as HTMLElement
      el.style.outline = '1px dotted blue' // customer's own inline style
      const { wrapper } = mountSidebar([rec({ id: 'c-here' })])

      const row = wrapper.find('.c11n-sidebar-row')
      await row.trigger('click')
      vi.advanceTimersByTime(400) // mid-flash
      await row.trigger('click') // second click while flash active

      vi.advanceTimersByTime(5000) // all timers done
      expect(el.classList.contains('c11n-flash')).toBe(false)
      expect(el.style.outline).toBe('1px dotted blue') // original, not orange
    } finally {
      vi.useRealTimers()
    }
  })

  it('clicking a row for another page does not open a thread (navigates instead)', async () => {
    const { store, wrapper } = mountSidebar([rec({ id: 'c-away', path: '/about' })])

    await wrapper.find('.c11n-sidebar-row').trigger('click')

    expect(store.activeCommentId).toBeNull()
  })

  it('the close button closes the sidebar', async () => {
    const { store, wrapper } = mountSidebar([])
    await wrapper.find('.c11n-sidebar-close').trigger('click')
    expect(store.sidebarOpen).toBe(false)
  })
})
