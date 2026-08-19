<script setup>
import { ref } from 'vue'

const clicks = ref(0)
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
  </section>
</template>
