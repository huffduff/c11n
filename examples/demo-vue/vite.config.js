import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// This app sits behind the c11n Caddy proxy, so accept any Host header and
// bind on all interfaces (the proxy reaches it by container/host name).
export default defineConfig({
  plugins: [vue()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
  },
})
