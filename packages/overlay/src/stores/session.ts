import { defineStore } from 'pinia'
import { backend } from '../lib/backend'
import { goToSignIn } from '../lib/signin'
import type { Me } from '../lib/types'

/**
 * Auth session state for the overlay.
 *
 * There is no login form any more (ADR 0006): the proxy's gate guarantees a
 * session before this bundle even loads, so `init()` only has to ask who that
 * is. A 401 means the cookie died mid-session — the overlay hands the user to
 * the sign-in page instead of rendering a signed-in shell that cannot read or
 * write anything.
 */
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
    async init() {
      this.loading = true
      this.error = null
      try {
        this.me = await backend.me()
        if (!this.me) goToSignIn('expired')
      } catch {
        // A network failure is not "signed out": bouncing to a page that may
        // also be unreachable would hide the real problem. Leave the overlay
        // signed out and let the next navigation re-check.
        this.me = null
      } finally {
        this.loading = false
      }
    },

    /**
     * Clear the cookie and leave for the sign-in page. The backend navigates;
     * dropping `me` here keeps the UI from flashing an authed toolbar while
     * the request is in flight.
     */
    async logout() {
      try {
        await backend.logout()
      } finally {
        this.me = null
      }
    },
  },
})
