<script setup>
import { onMounted, ref } from 'vue'

const clicks = ref(0)

// Same-origin API probe. The vite dev fixture has no /api/ping, so a failed
// fetch must render "unavailable" rather than break the page: the same app has
// to work under both topologies (dev: vite, prod: the Go server).
const api = ref('checking')
onMounted(async () => {
  try {
    const res = await fetch('/api/ping')
    const body = res.ok ? await res.json() : null
    api.value = body?.server ?? 'unavailable'
  } catch {
    api.value = 'unavailable'
  }
})
</script>

<template>
  <section>
    <h1 id="hero-title">Widgets that spark joy</h1>
    <p id="hero-copy">
      Acme builds the finest artisanal widgets on the market. Every widget is
      hand-tuned, batch-tested, and shipped with a smile.
    </p>
    <button id="cta-button" @click="clicks++">
      Get started {{ clicks > 0 ? `(${clicks})` : '' }}
    </button>
    <ul id="feature-list">
      <li>Zero-config setup</li>
      <li>Works with any stack</li>
      <li>Free tier forever</li>
    </ul>
    <p id="api-status" data-testid="api-ping">api: {{ api }}</p>
  </section>
</template>
