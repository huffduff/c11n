<script setup>
import { ref } from 'vue'

const email = ref('')
const sent = ref(false)
</script>

<template>
  <section>
    <h1 id="about-title">About Acme</h1>
    <p id="about-copy">
      Founded in a garage in 2019, Acme now ships widgets to 40 countries.
      This route is lazy-loaded, so its DOM renders after navigation — a good
      test for review pins re-anchoring on late content.
    </p>
    <form id="contact-form" @submit.prevent="sent = true">
      <label for="contact-email">Get launch updates:</label>
      <input id="contact-email" v-model="email" type="email" placeholder="you@example.com" required />
      <button type="submit">Subscribe</button>
      <p v-if="sent" id="contact-thanks">Thanks — you're on the list!</p>
    </form>
  </section>
</template>

<style scoped>
form { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; margin-top: 1.5rem; }
</style>
