import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import cssText from './styles.css?inline'

function mount() {
  if (document.getElementById('c11n-root')) return
  const host = document.createElement('div')
  host.id = 'c11n-root'
  document.body.appendChild(host)
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = cssText
  shadow.appendChild(style)
  const target = document.createElement('div')
  shadow.appendChild(target)
  createApp(App).use(createPinia()).mount(target)
}

document.readyState === 'loading'
  ? document.addEventListener('DOMContentLoaded', mount)
  : mount()
