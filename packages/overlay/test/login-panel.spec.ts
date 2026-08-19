import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { setBackend } from '../src/lib/backend'
import type { C11nBackend, Me } from '../src/lib/api'
import { useSessionStore } from '../src/stores/session'
import LoginPanel from '../src/components/LoginPanel.vue'

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

describe('LoginPanel.vue', () => {
  let pinia: Pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    setBackend(makeMockBackend())
  })

  function mountPanel() {
    return mount(LoginPanel, { global: { plugins: [pinia] } })
  }

  it('renders email + password inputs and a submit button', () => {
    const wrapper = mountPanel()
    expect(wrapper.find('input[type="email"]').exists()).toBe(true)
    expect(wrapper.find('input[type="password"]').exists()).toBe(true)
    expect(wrapper.find('button[type="submit"]').exists()).toBe(true)
  })

  it('submit calls session.login with the typed values', async () => {
    const store = useSessionStore()
    const loginSpy = vi.spyOn(store, 'login')
    const wrapper = mountPanel()

    await wrapper.find('input[type="email"]').setValue('tom@hfdf.io')
    await wrapper.find('input[type="password"]').setValue('hunter2')
    await wrapper.find('form').trigger('submit')

    expect(loginSpy).toHaveBeenCalledWith('tom@hfdf.io', 'hunter2')
  })

  it('renders the error from the store', async () => {
    const store = useSessionStore()
    const wrapper = mountPanel()
    expect(wrapper.find('.c11n-login-error').exists()).toBe(false)

    store.error = 'Invalid email or password'
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.c11n-login-error').text()).toBe('Invalid email or password')
  })

  it('disables the submit button while loading', async () => {
    const store = useSessionStore()
    const wrapper = mountPanel()
    const button = wrapper.find('button[type="submit"]')
    expect(button.attributes('disabled')).toBeUndefined()

    store.loading = true
    await wrapper.vm.$nextTick()

    expect(button.attributes('disabled')).toBeDefined()
  })
})
