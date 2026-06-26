<template>
  <div class="collaboration-app">
    <!-- Header -->
    <header class="app-header">
      <div class="header-content">
        <h1 class="app-title">
          <span class="logo">🤝</span>
          c11n
        </h1>
        
        <div class="url-input-section">
          <input
            v-model="targetURL"
            @keyup.enter="loadURL"
            placeholder="Enter URL to review (e.g. https://example.com)"
            class="url-input"
          />
          <button @click="loadURL" class="load-button">
            Load
          </button>
        </div>

        <div class="header-controls">
          <button 
            @click="toggleAnnotationMode"
            :class="['annotation-toggle', { active: annotationMode }]"
          >
            {{ annotationMode ? '📝 Stop Annotating' : '💬 Start Annotating' }}
          </button>
        </div>
      </div>
    </header>

    <!-- Main Layout -->
    <div class="main-layout">
      <!-- Left: Website Preview -->
      <div class="preview-section">
        <div class="preview-header">
          <span class="current-url">{{ displayURL }}</span>
          <div class="connection-status" :class="{ connected: isConnected }">
            {{ isConnected ? '🟢 Connected' : '🔴 Disconnected' }}
          </div>
        </div>
        
        <div class="iframe-container">
          <iframe
            ref="previewIframe"
            :src="currentURL"
            @load="onIframeLoad"
            class="preview-iframe"
            frameborder="0"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-navigation"
          />
          
          <div v-if="!currentURL" class="iframe-placeholder">
            <div class="placeholder-content">
              <h3>👆 Enter a URL above to start collaborating</h3>
              <p>Load any web application and start adding collaborative comments</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Right: Collaboration Panel -->
      <aside class="collaboration-panel">
        <!-- User Info -->
        <div class="user-section">
          <h3>Your Identity</h3>
          <div class="user-info">
            <input 
              v-model="editableUser.name"
              @blur="updateUser"
              placeholder="Your name"
              class="user-name-input"
            />
            <div class="user-color" :style="{ backgroundColor: currentUser.color }"></div>
          </div>
        </div>

        <!-- Active Users -->
        <div class="users-section">
          <h3>
            Active Users 
            <span class="user-count">({{ activeUserCount }})</span>
          </h3>
          <div class="users-list">
            <div 
              v-for="user in activeUsers" 
              :key="user.id"
              class="user-item"
            >
              <div class="user-avatar" :style="{ backgroundColor: user.color }">
                {{ user.name.charAt(0).toUpperCase() }}
              </div>
              <span class="user-name">{{ user.name }}</span>
              <span class="user-status">online</span>
            </div>
            
            <div v-if="activeUserCount === 0" class="no-users">
              No other users connected
            </div>
          </div>
        </div>

        <!-- Annotations -->
        <div class="annotations-section">
          <h3>
            Comments 
            <span class="annotation-count">({{ annotationsForCurrentURL.length }})</span>
          </h3>
          
          <div class="annotations-list">
            <div 
              v-for="annotation in annotationsForCurrentURL" 
              :key="annotation.id"
              class="annotation-item"
            >
              <div class="annotation-header">
                <strong class="annotation-author">{{ annotation.author }}</strong>
                <span class="annotation-time">{{ formatTime(annotation.created) }}</span>
              </div>
              <div class="annotation-content">
                {{ annotation.text }}
              </div>
              <div class="annotation-meta">
                <code class="annotation-selector">{{ annotation.selector }}</code>
              </div>
              <div class="annotation-actions">
                <button 
                  @click="resolveAnnotation(annotation.id)"
                  class="resolve-button"
                  :disabled="annotation.resolved"
                >
                  {{ annotation.resolved ? '✅ Resolved' : '✓ Resolve' }}
                </button>
              </div>
            </div>
            
            <div v-if="annotationsForCurrentURL.length === 0" class="no-annotations">
              {{ currentURL ? 'No comments yet. Click elements in annotation mode to add comments.' : 'Load a URL to see comments' }}
            </div>
          </div>
        </div>

        <!-- Instructions -->
        <div class="instructions-section">
          <h3>How to Use</h3>
          <ol class="instructions-list">
            <li>Enter a website URL and click Load</li>
            <li>Click "Start Annotating" to enable comment mode</li>
            <li>Click any element on the website to add a comment</li>
            <li>Comments are shared in real-time with other users</li>
            <li>Navigate around the site - comments stay persistent</li>
          </ol>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useCollaborationStore } from '../stores/collaboration'

const store = useCollaborationStore()

// Refs
const targetURL = ref('https://example.com')
const previewIframe = ref<HTMLIFrameElement>()
const editableUser = ref({ name: store.currentUser.name })

// Computed
const currentURL = computed(() => store.currentURL)
const displayURL = computed(() => store.currentURL || 'No URL loaded')
const isConnected = computed(() => store.isConnected)
const annotationMode = computed(() => store.annotationMode)
const currentUser = computed(() => store.currentUser)
const activeUsers = computed(() => store.activeUsers)
const activeUserCount = computed(() => store.activeUserCount)
const annotationsForCurrentURL = computed(() => store.annotationsForCurrentURL)

// Methods
function loadURL() {
  if (!targetURL.value) return
  
  let url = targetURL.value.trim()
  
  // Add protocol if missing
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url
  }
  
  store.setCurrentURL(url)
}

function toggleAnnotationMode() {
  store.setAnnotationMode(!annotationMode.value)
}

function updateUser() {
  if (editableUser.value.name.trim()) {
    store.setCurrentUser({ name: editableUser.value.name.trim() })
  }
}

function onIframeLoad() {
  if (!previewIframe.value) return
  
  // Set iframe reference in store
  store.setIframeRef(previewIframe.value)
  
  nextTick(() => {
    try {
      // Inject annotation script into iframe
      const iframeDoc = previewIframe.value?.contentDocument
      if (iframeDoc) {
        // Load and inject our annotation script
        fetch('/annotation-inject.js')
          .then(response => response.text())
          .then(scriptContent => {
            const script = iframeDoc.createElement('script')
            script.textContent = scriptContent
            iframeDoc.head.appendChild(script)
            
            // Initialize with current user
            setTimeout(() => {
              if (previewIframe.value?.contentWindow) {
                try {
                  (previewIframe.value.contentWindow as any).c11nAPI?.setUser(store.currentUser)
                } catch (error) {
                  console.warn('Could not initialize user in iframe:', error)
                }
              }
            }, 500)
          })
          .catch(error => {
            console.error('Failed to inject annotation script:', error)
          })
      }
    } catch (error) {
      console.warn('Cross-origin iframe, cannot inject script:', error)
    }
  })
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString()
}

function resolveAnnotation(id: string) {
  store.resolveAnnotation(id)
}

// Lifecycle
onMounted(() => {
  store.connectWebSocket()
})

onUnmounted(() => {
  store.disconnectWebSocket()
})
</script>

<style scoped>
.collaboration-app {
  height: 100vh;
  display: flex;
  flex-direction: column;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

.app-header {
  background: #2c3e50;
  color: white;
  padding: 1rem;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.header-content {
  display: flex;
  align-items: center;
  gap: 2rem;
  max-width: 1400px;
  margin: 0 auto;
}

.app-title {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1.5rem;
  min-width: 120px;
}

.logo {
  font-size: 1.8rem;
}

.url-input-section {
  flex: 1;
  display: flex;
  gap: 0.5rem;
  max-width: 500px;
}

.url-input {
  flex: 1;
  padding: 0.5rem 0.75rem;
  border: none;
  border-radius: 4px;
  font-size: 14px;
}

.load-button {
  padding: 0.5rem 1rem;
  background: #3498db;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
}

.load-button:hover {
  background: #2980b9;
}

.header-controls {
  display: flex;
  gap: 1rem;
}

.annotation-toggle {
  padding: 0.5rem 1rem;
  border: 2px solid #ecf0f1;
  background: transparent;
  color: white;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
}

.annotation-toggle.active {
  background: #e74c3c;
  border-color: #e74c3c;
}

.annotation-toggle:hover {
  background: rgba(255,255,255,0.1);
}

.main-layout {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.preview-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #f8f9fa;
}

.preview-header {
  background: white;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid #dee2e6;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 14px;
}

.current-url {
  color: #6c757d;
  font-family: monospace;
}

.connection-status {
  color: #dc3545;
  font-weight: 500;
}

.connection-status.connected {
  color: #28a745;
}

.iframe-container {
  flex: 1;
  position: relative;
  background: white;
}

.preview-iframe {
  width: 100%;
  height: 100%;
  border: none;
}

.iframe-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f8f9fa;
}

.placeholder-content {
  text-align: center;
  color: #6c757d;
}

.placeholder-content h3 {
  margin: 0 0 0.5rem 0;
  color: #495057;
}

.collaboration-panel {
  width: 320px;
  background: white;
  border-left: 1px solid #dee2e6;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.collaboration-panel > div {
  padding: 1rem;
  border-bottom: 1px solid #dee2e6;
}

.collaboration-panel h3 {
  margin: 0 0 1rem 0;
  color: #495057;
  font-size: 14px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.user-info {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.user-name-input {
  flex: 1;
  padding: 0.5rem;
  border: 1px solid #dee2e6;
  border-radius: 4px;
  font-size: 14px;
}

.user-color {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid #dee2e6;
}

.users-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.user-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem;
  background: #f8f9fa;
  border-radius: 4px;
}

.user-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: 600;
  font-size: 12px;
}

.user-name {
  flex: 1;
  font-weight: 500;
  font-size: 14px;
}

.user-status {
  font-size: 12px;
  color: #28a745;
}

.user-count, .annotation-count {
  color: #6c757d;
  font-weight: normal;
}

.annotations-section {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.annotations-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.annotation-item {
  padding: 0.75rem;
  background: #f8f9fa;
  border-radius: 6px;
  border-left: 3px solid #007bff;
}

.annotation-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}

.annotation-author {
  font-size: 14px;
  color: #495057;
}

.annotation-time {
  font-size: 12px;
  color: #6c757d;
}

.annotation-content {
  margin-bottom: 0.5rem;
  font-size: 14px;
  line-height: 1.4;
}

.annotation-meta {
  margin-bottom: 0.5rem;
}

.annotation-selector {
  background: #e9ecef;
  padding: 2px 4px;
  border-radius: 2px;
  font-size: 11px;
  color: #495057;
}

.annotation-actions {
  display: flex;
  gap: 0.5rem;
}

.resolve-button {
  padding: 0.25rem 0.5rem;
  background: #28a745;
  color: white;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  font-size: 12px;
}

.resolve-button:disabled {
  background: #6c757d;
  cursor: not-allowed;
}

.no-users, .no-annotations {
  color: #6c757d;
  font-style: italic;
  font-size: 14px;
  text-align: center;
  padding: 1rem 0;
}

.instructions-section {
  border-bottom: none;
}

.instructions-list {
  font-size: 14px;
  line-height: 1.5;
  color: #6c757d;
  margin: 0;
  padding-left: 1.25rem;
}

.instructions-list li {
  margin-bottom: 0.5rem;
}
</style>