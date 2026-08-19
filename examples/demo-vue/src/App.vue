<script setup>
</script>

<template>
  <header class="site-header">
    <span id="logo" class="logo">Acme Widgets</span>
    <nav>
      <RouterLink to="/">Home</RouterLink>
      <RouterLink to="/pricing">Pricing</RouterLink>
      <RouterLink to="/about">About</RouterLink>
    </nav>
  </header>
  <main>
    <RouterView />
  </main>
  <footer class="site-footer">
    <p id="footer-note">Demo site reviewed through the c11n proxy — this app ships zero c11n code.</p>
  </footer>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; color: #1f2933; background: #f8fafc; }
.site-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 1rem 2rem; background: #0f172a; color: #f8fafc;
}
.logo { font-weight: 700; letter-spacing: 0.03em; }
nav a { color: #cbd5e1; margin-left: 1.25rem; text-decoration: none; }
nav a.router-link-active { color: #fff; font-weight: 600; }
main { max-width: 46rem; margin: 0 auto; padding: 2rem; }
.site-footer { text-align: center; color: #64748b; padding: 2rem; font-size: 0.85rem; }
button {
  background: #2563eb; color: #fff; border: 0; border-radius: 6px;
  padding: 0.5rem 1rem; font-size: 1rem; cursor: pointer;
}
button:hover { background: #1d4ed8; }
input {
  padding: 0.5rem 0.75rem; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 1rem;
}
</style>
