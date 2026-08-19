<script setup lang="ts">
import { ref } from 'vue'
import { useSessionStore } from '../stores/session'

const session = useSessionStore()
const email = ref('')
const password = ref('')

function submit() {
  session.login(email.value, password.value)
}
</script>

<template>
  <form class="c11n-login" @submit.prevent="submit">
    <div class="c11n-login-title">Sign in to c11n</div>
    <input
      v-model="email"
      class="c11n-input"
      type="email"
      placeholder="Email"
      aria-label="Email"
      autocomplete="email"
      required
      :disabled="session.loading"
    />
    <input
      v-model="password"
      class="c11n-input"
      type="password"
      placeholder="Password"
      aria-label="Password"
      autocomplete="current-password"
      required
      :disabled="session.loading"
    />
    <p v-if="session.error" class="c11n-login-error" role="alert">{{ session.error }}</p>
    <button class="c11n-btn" type="submit" :disabled="session.loading">
      {{ session.loading ? 'Signing in…' : 'Sign in' }}
    </button>
  </form>
</template>
