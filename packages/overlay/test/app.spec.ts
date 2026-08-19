import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { setBackend } from '../src/lib/backend'
import type { C11nBackend, Me } from '../src/lib/api'
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

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
  })

  function mountApp() {
    return mount(App, { global: { plugins: [pinia] } })
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
