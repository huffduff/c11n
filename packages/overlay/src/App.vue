<script setup lang="ts">
// Auth shell: sign-in chip + login panel when logged out, placeholder
// toolbar pill when signed in. The real toolbar arrives in Task 10.
import { onMounted, ref } from 'vue'
import LoginPanel from './components/LoginPanel.vue'
import { useSessionStore } from './stores/session'

const session = useSessionStore()
const showLogin = ref(false)

onMounted(() => session.init())

function signOut() {
  session.logout()
  showLogin.value = false
}
</script>

<template>
  <div v-if="session.isAuthed" class="c11n-toolbar">
    <span class="c11n-logo">c11n</span>
    <span class="c11n-user">{{ session.me?.name }}</span>
    <button class="c11n-signout" type="button" @click="signOut">Sign out</button>
  </div>
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
