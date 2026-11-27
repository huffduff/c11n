import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'

// The session store redirects on a 401; jsdom cannot navigate, so the redirect
// is a mock. The no-cookie path is covered by session.spec.ts.
vi.mock('../src/lib/signin', () => ({
  signInUrl: (reason: string) => `/__c11n/auth/?reason=${reason}`,
  goToSignIn: vi.fn(),
}))

import { setBackend } from '../src/lib/backend'
import type { C11nBackend, Me } from '../src/lib/api'
import { PROJECT } from '../src/lib/project'
import { useCommentsStore } from '../src/stores/comments'
import { useSessionStore } from '../src/stores/session'
import App from '../src/App.vue'

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

  it('signed out (no cookie): renders no overlay UI at all', async () => {
    setBackend(makeMockBackend({ me: vi.fn().mockResolvedValue(null) }))
    const wrapper = mountApp()
    await vi.waitFor(() => expect(useSessionStore().loading).toBe(false))

    // No in-overlay sign-in chip or form: the gate already sent the browser to
    // the sign-in page (task 3.8), so this bundle should not exist in that case.
    expect(wrapper.find('.c11n-signin-chip').exists()).toBe(false)
    expect(wrapper.find('.c11n-login').exists()).toBe(false)
    expect(wrapper.find('.c11n-toolbar').exists()).toBe(false)
  })

  it('signed in: shows the toolbar with the user name + sign out', async () => {
    setBackend(makeMockBackend({ me: vi.fn().mockResolvedValue(tom) }))
    const wrapper = mountApp()
    await vi.waitFor(() => expect(wrapper.find('.c11n-toolbar').exists()).toBe(true))

    expect(wrapper.find('.c11n-signin-chip').exists()).toBe(false)
    expect(wrapper.find('.c11n-toolbar').text()).toContain('Tom')
    expect(wrapper.find('.c11n-signout').exists()).toBe(true)
  })

  it('sign out clears the cookie through the backend and drops the toolbar', async () => {
    const mock = makeMockBackend({ me: vi.fn().mockResolvedValue(tom) })
    setBackend(mock)
    const wrapper = mountApp()
    await vi.waitFor(() => expect(wrapper.find('.c11n-toolbar').exists()).toBe(true))

    await wrapper.find('.c11n-signout').trigger('click')

    expect(mock.logout).toHaveBeenCalled()
    await vi.waitFor(() => expect(wrapper.find('.c11n-toolbar').exists()).toBe(false))
    expect(wrapper.find('.c11n-signin-chip').exists()).toBe(false)
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
    const mock = makeMockBackend({ me: vi.fn().mockResolvedValue(tom), ...overrides })
    setBackend(mock)
    wrapper = mount(App, { global: { plugins: [pinia] } })
    // init() is async now: wait for the authed render before asserting.
    await vi.waitFor(() => expect(wrapper!.find('.c11n-toolbar').exists()).toBe(true))
    await nextTick()
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
