import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { setBackend } from '../src/lib/backend'
import type { C11nBackend, Me } from '../src/lib/api'
import { PROJECT } from '../src/lib/project'
import { useCommentsStore } from '../src/stores/comments'
import App from '../src/App.vue'

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

describe('App.vue auth states', () => {
  let pinia: Pinia
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    document.body.innerHTML = ''
    pinia = createPinia()
    setActivePinia(pinia)
  })

  afterEach(() => {
    // Unmount so App's watchers tear down picker/navigation listeners.
    wrapper?.unmount()
    wrapper = null
  })

  function mountApp() {
    wrapper = mount(App, { global: { plugins: [pinia] } })
    return wrapper
  }

  it('logged out: shows the sign-in chip, no login panel until clicked', async () => {
    setBackend(makeMockBackend({ me: vi.fn().mockReturnValue(null) }))
    const wrapper = mountApp()

    const chip = wrapper.find('.c11n-signin-chip')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('Sign in to comment')
    expect(wrapper.find('.c11n-login').exists()).toBe(false)

    await chip.trigger('click')
    expect(wrapper.find('.c11n-login').exists()).toBe(true)

    await chip.trigger('click')
    expect(wrapper.find('.c11n-login').exists()).toBe(false)
  })

  it('logged in (persisted session): shows toolbar pill with user name + sign out', async () => {
    setBackend(makeMockBackend({ me: vi.fn().mockReturnValue(tom) }))
    const wrapper = mountApp()
    await nextTick() // onMounted → session.init() re-render

    expect(wrapper.find('.c11n-signin-chip').exists()).toBe(false)
    const toolbar = wrapper.find('.c11n-toolbar')
    expect(toolbar.exists()).toBe(true)
    expect(toolbar.text()).toContain('Tom')
    expect(wrapper.find('.c11n-signout').exists()).toBe(true)
  })

  it('sign out returns to the logged-out chip', async () => {
    const mock = makeMockBackend({ me: vi.fn().mockReturnValue(tom) })
    setBackend(mock)
    const wrapper = mountApp()
    await nextTick() // onMounted → session.init() re-render

    await wrapper.find('.c11n-signout').trigger('click')

    expect(mock.logout).toHaveBeenCalled()
    expect(wrapper.find('.c11n-signin-chip').exists()).toBe(true)
    expect(wrapper.find('.c11n-signout').exists()).toBe(false)
  })
})

describe('App.vue comment mode integration', () => {
  let pinia: Pinia
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    document.body.innerHTML = ''
    document.body.style.cursor = ''
    pinia = createPinia()
    setActivePinia(pinia)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  async function mountAuthed(overrides: Partial<C11nBackend> = {}) {
    const mock = makeMockBackend({ me: vi.fn().mockReturnValue(tom), ...overrides })
    setBackend(mock)
    wrapper = mount(App, { global: { plugins: [pinia] } })
    await nextTick() // session.init() → authed render + watchers flush
    return { mock, wrapper }
  }

  it('loads comments for the current page on mount when authed', async () => {
    const { mock } = await mountAuthed()

    expect(mock.listComments).toHaveBeenCalledWith(PROJECT, '/')
    const comments = useCommentsStore()
    expect(comments.currentPath).toBe('/')
  })

  it('toggle enters pick mode and activates the document picker (crosshair cursor)', async () => {
    const { wrapper } = await mountAuthed()
    const comments = useCommentsStore()

    await wrapper.find('.c11n-mode-toggle').trigger('click')

    expect(comments.mode).toBe('pick')
    expect(document.body.style.cursor).toBe('crosshair')

    await wrapper.find('.c11n-mode-toggle').trigger('click')
    expect(comments.mode).toBe('off')
    expect(document.body.style.cursor).toBe('')
  })

  it('clicking a page element in pick mode anchors it and opens the composer', async () => {
    const { wrapper } = await mountAuthed()
    const comments = useCommentsStore()
    const target = document.createElement('button')
    target.id = 'hero-btn'
    target.textContent = 'Buy now'
    document.body.appendChild(target)

    await wrapper.find('.c11n-mode-toggle').trigger('click')
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    target.dispatchEvent(ev)
    await nextTick()

    expect(ev.defaultPrevented).toBe(true) // reviewed SPA never navigates
    expect(comments.pendingAnchor?.selector).toBe('#hero-btn')
    expect(wrapper.find('.c11n-composer').exists()).toBe(true)
  })

  it('saving from the composer persists through the backend and closes it', async () => {
    const saved = {
      id: 'c-new',
      project: PROJECT,
      path: '/',
      selector: '#hero-btn',
      anchorMeta: null,
      body: 'Make it pop',
      author: tom.id,
      resolved: false,
      created: 'now',
      updated: 'now',
    }
    const { mock, wrapper } = await mountAuthed({
      createComment: vi.fn().mockResolvedValue(saved),
    })
    const target = document.createElement('button')
    target.id = 'hero-btn'
    document.body.appendChild(target)

    await wrapper.find('.c11n-mode-toggle').trigger('click')
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await nextTick()

    await wrapper.find('.c11n-composer textarea').setValue('Make it pop')
    await wrapper.find('.c11n-composer-save').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('.c11n-composer').exists()).toBe(false)
    })

    expect(mock.createComment).toHaveBeenCalledWith({
      project: PROJECT,
      path: '/',
      selector: '#hero-btn',
      anchorMeta: expect.objectContaining({ tag: 'button' }),
      body: 'Make it pop',
    })
    const comments = useCommentsStore()
    expect(comments.items).toContainEqual(saved)
    expect(comments.mode).toBe('off')
    expect(document.body.style.cursor).toBe('') // picker cleaned up after save
  })

  it('unmount tears the picker down', async () => {
    const { wrapper } = await mountAuthed()
    await wrapper.find('.c11n-mode-toggle').trigger('click')
    expect(document.body.style.cursor).toBe('crosshair')

    wrapper.unmount()

    expect(document.body.style.cursor).toBe('')
    const target = document.createElement('button')
    document.body.appendChild(target)
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    target.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
  })
})
