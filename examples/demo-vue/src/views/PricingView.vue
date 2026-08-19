<script setup>
import { ref } from 'vue'

const seats = ref(5)
const plans = [
  { id: 'starter', name: 'Starter', price: 0 },
  { id: 'team', name: 'Team', price: 12 },
  { id: 'enterprise', name: 'Enterprise', price: 49 },
]
</script>

<template>
  <section>
    <h1 id="pricing-title">Simple pricing</h1>
    <label id="seat-label">
      Seats:
      <input id="seat-input" v-model.number="seats" type="number" min="1" max="500" />
    </label>
    <div class="plans">
      <article v-for="plan in plans" :id="`plan-${plan.id}`" :key="plan.id" class="plan">
        <h2>{{ plan.name }}</h2>
        <p class="price">${{ plan.price * seats }}<span>/mo</span></p>
        <button>Choose {{ plan.name }}</button>
      </article>
    </div>
  </section>
</template>

<style scoped>
.plans { display: flex; gap: 1rem; margin-top: 1.5rem; }
.plan { flex: 1; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1.25rem; text-align: center; }
.price { font-size: 1.5rem; font-weight: 700; }
.price span { font-size: 0.85rem; color: #64748b; font-weight: 400; }
</style>
