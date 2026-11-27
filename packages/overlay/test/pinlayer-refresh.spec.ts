import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { setBackend } from '../src/lib/backend'
import type { C11nBackend, CommentRec } from '../src/lib/api'
import { PROJECT } from '../src/lib/project'
import { useCommentsStore } from '../src/stores/comments'
import PinLayer from '../src/components/PinLayer.vue'

// Wrap the real tracker so the test can observe PinLayer's calls into it
// (behaviour is unchanged — every call is delegated).
const trackerSpy = vi.hoisted(() => ({ refresh: 0, created: 0 }))

vi.mock('../src/lib/tracker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/tracker')>()
  return {
    ...actual,
    trackElements: (...args: Parameters<typeof actual.trackElements>) => {
      const tracker = actual.trackElements(...args)
      trackerSpy.created++
      return {
        stop: tracker.stop,
        refresh: () => {
          trackerSpy.refresh++
          tracker.refresh()
        },
      }
    },
  }
})

function rec(overrides: Partial<CommentRec> = {}): CommentRec {
  return {
    id: 'c1',
    project: PROJECT,
    path: '/pricing',
    selector: '#alpha',
    anchorMeta: { tag: 'div', text: 'Alpha section', rect: { x: 0, y: 0, width: 10, height: 10 } },
    body: 'Comment',
    author: 'u1',
    authorName: 'Tom',
    resolved: false,
    created: '2026-08-19 10:00:00',
    updated: '2026-08-19 10:00:00',
    ...overrides,
  }
}

function makeMockBackend(): C11nBackend {
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
  }
}

// B3 wiring: when the item set lands after mount, PinLayer must ask the
// (already running) tracker for a frame — the document did not change, so no
// mutation would otherwise trigger a recompute and the pins keep no rects.
describe('PinLayer → tracker.refresh() on items load', () => {
  let pinia: Pinia
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    trackerSpy.refresh = 0
    trackerSpy.created = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    setActivePinia((pinia = createPinia()))
    setBackend(makeMockBackend())
    document.body.innerHTML = '<div id="alpha">Alpha section</div>'
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    vi.unstubAllGlobals()
  })

  it('refreshes the existing tracker when items arrive after mount', async () => {
    const store = useCommentsStore()
    store.currentPath = '/pricing'
    store.items = []
    wrapper = mount(PinLayer, { global: { plugins: [pinia] } })
    await nextTick()
    expect(trackerSpy.created).toBe(1)
    expect(trackerSpy.refresh).toBe(0)

    // setPath finished after the overlay mounted: the tracker already exists,
    // so re-resolution alone would leave the new pin unmeasured.
    store.items = [rec()]
    await nextTick()
    await nextTick()

    expect(trackerSpy.refresh).toBeGreaterThan(0)
    expect(wrapper.findAll('.c11n-pin')).toHaveLength(1)
    expect(wrapper.find('.c11n-pin').attributes('style') ?? '').not.toContain('display: none')
  })
})
