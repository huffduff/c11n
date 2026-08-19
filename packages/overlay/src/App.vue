<script setup lang="ts">
// Shell: login flow when signed out; toolbar + comment mode when signed in.
// All raw-DOM wiring (picker listeners, SPA nav hook) lives here so the
// components underneath stay dumb.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import LoginPanel from './components/LoginPanel.vue'
import Toolbar from './components/Toolbar.vue'
import Composer from './components/Composer.vue'
import PinLayer from './components/PinLayer.vue'
import ThreadPopover from './components/ThreadPopover.vue'
import { useSessionStore } from './stores/session'
import { useCommentsStore } from './stores/comments'
import { createAnchor } from './lib/anchor'
import { startPicking, setLastPickedElement } from './lib/picker'
import { normalizePath, onNavigate } from './lib/url'

const session = useSessionStore()
const comments = useCommentsStore()
const showLogin = ref(false)

let stopPicking: (() => void) | null = null
let stopNav: (() => void) | null = null

onMounted(() => session.init())

// Auth drives page tracking: load comments for the current page and follow
// SPA navigations while signed in; tear down (and leave pick mode) on logout.
watch(
  () => session.isAuthed,
  (authed) => {
    if (authed) {
      showLogin.value = false
      comments.setPath(normalizePath(location.href))
      stopNav = onNavigate((path) => comments.setPath(path))
    } else {
      stopNav?.()
      stopNav = null
      comments.exitPickMode()
    }
  },
)

// Mode drives the picker: capture-phase listeners keep body clicks from ever
// reaching the reviewed SPA while picking.
watch(
  () => comments.mode,
  (mode) => {
    if (mode === 'pick') {
      stopPicking = startPicking((el) => {
        try {
          comments.beginCompose(createAnchor(el))
        } catch {
          // Element inside the overlay host — picker filters these, but
          // createAnchor's safety net can still throw. Ignore the pick.
        }
      })
    } else {
      stopPicking?.()
      stopPicking = null
      setLastPickedElement(null)
    }
  },
)

onBeforeUnmount(() => {
  stopPicking?.()
  stopNav?.()
})
</script>

<template>
  <template v-if="session.isAuthed">
    <!-- Pins live in the shadow root, so the picker's #c11n-root filter
         already keeps pick-mode clicks and pin clicks from fighting. -->
    <PinLayer />
    <Toolbar />
    <Composer v-if="comments.pendingAnchor" />
    <!-- Keyed so switching threads remounts (fresh replies load + position). -->
    <ThreadPopover
      v-if="comments.activeCommentId"
      :key="comments.activeCommentId"
    />
  </template>
  <template v-else>
    <button
      class="c11n-toolbar c11n-signin-chip"
      type="button"
      @click="showLogin = !showLogin"
    >
      <span class="c11n-logo">c11n</span>
      <span>Sign in to comment</span>
    </button>
    <LoginPanel v-if="showLogin" />
  </template>
</template>
