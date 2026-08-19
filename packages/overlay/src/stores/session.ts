import { defineStore } from 'pinia'
import { backend } from '../lib/backend'
import type { Me } from '../lib/types'

/** Auth session state for the overlay. */
export const useSessionStore = defineStore('session', {
  state: () => ({
    me: null as Me | null,
    loading: false,
    error: null as string | null,
  }),

  getters: {
    isAuthed: (state) => state.me !== null,
  },

  actions: {
    /** Restore a persisted session (the PB SDK hydrates auth from localStorage). */
    init() {
      this.me = backend.me()
    },

    async login(email: string, password: string) {
      this.loading = true
      this.error = null
      try {
        this.me = await backend.login(email, password)
      } catch (err) {
        const status = (err as { status?: number } | null)?.status
        this.error =
          status === 400 ? 'Invalid email or password' : 'Sign-in failed, please try again'
      } finally {
        this.loading = false
      }
    },

    logout() {
      backend.logout()
      this.me = null
    },
  },
})
