import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { computePosition } from '@floating-ui/dom'
import { setBackend } from '../src/lib/backend'
import type { C11nBackend } from '../src/lib/api'
import type { Anchor } from '../src/lib/anchor'
import { setLastPickedElement } from '../src/lib/picker'
import { useCommentsStore } from '../src/stores/comments'
import Composer from '../src/components/Composer.vue'

vi.mock('@floating-ui/dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@floating-ui/dom')>()
  return {
    ...actual,
    computePosition: vi.fn().mockResolvedValue({ x: 12, y: 34 }),
  }
})

const anchor: Anchor = {
  selector: '#hero',
  meta: { tag: 'button', text: 'Buy', rect: { x: 0, y: 0, width: 10, height: 10 } },
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

describe('Composer.vue', () => {
  let pinia: Pinia
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    document.body.innerHTML = ''
    pinia = createPinia()
    setActivePinia(pinia)
    setBackend(makeMockBackend())
    setLastPickedElement(null)
    vi.mocked(computePosition).mockClear()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  function mountComposer() {
    const store = useCommentsStore()
    store.enterPickMode()
    store.beginCompose(anchor)
    wrapper = mount(Composer, { global: { plugins: [pinia] } })
    return { store, wrapper }
  }

  it('renders a textarea and Save/Cancel buttons', () => {
    const { wrapper } = mountComposer()
    expect(wrapper.find('textarea').exists()).toBe(true)
    expect(wrapper.find('.c11n-composer-save').exists()).toBe(true)
    expect(wrapper.find('.c11n-composer-cancel').exists()).toBe(true)
  })

  it('save calls store.saveComment with the typed text', async () => {
    const { store, wrapper } = mountComposer()
    const saveSpy = vi.spyOn(store, 'saveComment')

    await wrapper.find('textarea').setValue('Make it pop')
    await wrapper.find('.c11n-composer-save').trigger('click')

    expect(saveSpy).toHaveBeenCalledWith('Make it pop')
  })

  it('cancel calls store.cancelCompose', async () => {
    const { store, wrapper } = mountComposer()
    const cancelSpy = vi.spyOn(store, 'cancelCompose')

    await wrapper.find('.c11n-composer-cancel').trigger('click')

    expect(cancelSpy).toHaveBeenCalled()
  })

  it('disables textarea and save while the store is loading', async () => {
    const { store, wrapper } = mountComposer()
    await wrapper.find('textarea').setValue('text so save is not empty-disabled')

    store.loading = true
    await wrapper.vm.$nextTick()

    expect(wrapper.find('textarea').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.c11n-composer-save').attributes('disabled')).toBeDefined()
  })

  it('disables save when the textarea is empty', () => {
    const { wrapper } = mountComposer()
    expect(wrapper.find('.c11n-composer-save').attributes('disabled')).toBeDefined()
  })

  it('positions against the picked element via computePosition', async () => {
    const picked = document.createElement('button')
    document.body.appendChild(picked)
    setLastPickedElement(picked)

    const { wrapper } = mountComposer()
    // onMounted → computePosition is async; flush microtasks
    await wrapper.vm.$nextTick()
    await Promise.resolve()

    expect(computePosition).toHaveBeenCalledTimes(1)
    expect(vi.mocked(computePosition).mock.calls[0][0]).toBe(picked)
  })

  it('skips positioning when no picked element is known', async () => {
    const { wrapper } = mountComposer()
    await wrapper.vm.$nextTick()
    await Promise.resolve()

    expect(computePosition).not.toHaveBeenCalled()
  })
})
