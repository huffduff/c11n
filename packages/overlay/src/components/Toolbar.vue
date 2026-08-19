<script setup lang="ts">
// Authed toolbar pill: logo, comment-mode toggle, unresolved badge, sign-out.
// Deliberately dumb — toggling only flips store mode; the DOM wiring
// (picker listeners) lives in App.vue watching comments.mode.
import { useCommentsStore } from '../stores/comments'
import { useSessionStore } from '../stores/session'

const session = useSessionStore()
const comments = useCommentsStore()

function toggleMode() {
  if (comments.mode === 'pick') comments.exitPickMode()
  else comments.enterPickMode()
}
</script>

<template>
  <div class="c11n-toolbar">
    <span class="c11n-logo">c11n</span>
    <button
      class="c11n-mode-toggle"
      :class="{ 'c11n-mode-on': comments.mode === 'pick' }"
      type="button"
      :title="comments.mode === 'pick' ? 'Exit comment mode' : 'Comment on an element'"
      :aria-pressed="comments.mode === 'pick'"
      @click="toggleMode"
    >
      ✚
    </button>
    <button
      class="c11n-sidebar-toggle"
      :class="{ 'c11n-mode-on': comments.sidebarOpen }"
      type="button"
      :title="comments.sidebarOpen ? 'Hide comment list' : 'Show comment list'"
      :aria-pressed="comments.sidebarOpen"
      @click="comments.toggleSidebar()"
    >
      ≡
    </button>
    <span v-if="comments.unresolvedCount > 0" class="c11n-badge">
      {{ comments.unresolvedCount }}
    </span>
    <span class="c11n-user">{{ session.me?.name }}</span>
    <button class="c11n-signout" type="button" @click="session.logout()">Sign out</button>
  </div>
</template>
