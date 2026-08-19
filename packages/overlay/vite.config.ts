import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    lib: { entry: 'src/main.ts', formats: ['iife'], name: 'C11N', fileName: () => 'overlay.js' },
    cssCodeSplit: false,
    rollupOptions: { output: { assetFileNames: 'overlay.[ext]' } },
  },
})
