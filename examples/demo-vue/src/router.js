import { createRouter, createWebHistory } from 'vue-router'
import HomeView from './views/HomeView.vue'
import PricingView from './views/PricingView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    { path: '/pricing', name: 'pricing', component: PricingView },
    // Lazy route: exercises the overlay's late-render pin re-resolution —
    // the chunk loads after navigation, so anchored elements appear late.
    { path: '/about', name: 'about', component: () => import('./views/AboutView.vue') },
  ],
})
