import { ref, computed } from 'vue'
import { defineStore } from 'pinia'

// Types
interface User {
  id: string
  name: string
  email?: string
  color: string
  joined_at: string
}

interface Annotation {
  id: string
  url: string
  selector: string
  text: string
  author: string
  created: string
  resolved: boolean
  element_html?: string
  bounding_box?: {
    x: number
    y: number 
    width: number
    height: number
  }
}

interface WebSocketMessage {
  type: string
  data: any
}

export const useCollaborationStore = defineStore('collaboration', () => {
  // State
  const currentUser = ref<User>({
    id: 'user_' + Math.random().toString(36).substr(2, 9),
    name: 'Anonymous User',
    email: '',
    color: '#007bff',
    joined_at: new Date().toISOString()
  })
  
  const activeUsers = ref<User[]>([])
  const annotations = ref<Annotation[]>([])
  const currentURL = ref('')
  const isConnected = ref(false)
  const annotationMode = ref(false)
  
  // WebSocket
  const websocket = ref<WebSocket | null>(null)
  const iframeRef = ref<HTMLIFrameElement | null>(null)

  // Getters
  const annotationsForCurrentURL = computed(() => 
    annotations.value.filter(a => a.url === currentURL.value && !a.resolved)
  )

  const activeUserCount = computed(() => activeUsers.value.length)

  // Actions
  function setCurrentUser(user: Partial<User>) {
    Object.assign(currentUser.value, user)
    
    // Update user in iframe if connected
    if (iframeRef.value?.contentWindow) {
      try {
        (iframeRef.value.contentWindow as any).c11nAPI?.setUser(currentUser.value)
      } catch (error) {
        console.warn('Could not update user in iframe:', error)
      }
    }
  }

  function setIframeRef(iframe: HTMLIFrameElement) {
    iframeRef.value = iframe
  }

  function setCurrentURL(url: string) {
    currentURL.value = normalizeURL(url)
    
    // Load annotations for new URL
    loadAnnotationsForURL(currentURL.value)
    
    // Join new room via WebSocket
    if (isConnected.value) {
      joinRoom(currentURL.value)
    }
  }

  function setAnnotationMode(enabled: boolean) {
    annotationMode.value = enabled
    
    // Update annotation mode in iframe
    if (iframeRef.value?.contentWindow) {
      try {
        (iframeRef.value.contentWindow as any).c11nAPI?.setAnnotationMode(enabled)
      } catch (error) {
        console.warn('Could not set annotation mode in iframe:', error)
      }
    }
  }

  // WebSocket connection
  function connectWebSocket() {
    try {
      websocket.value = new WebSocket('ws://localhost:8080/ws')
      
      websocket.value.onopen = () => {
        isConnected.value = true
        console.log('Connected to collaboration server')
        
        // Join room for current URL if set
        if (currentURL.value) {
          joinRoom(currentURL.value)
        }
      }

      websocket.value.onmessage = (event) => {
        const message: WebSocketMessage = JSON.parse(event.data)
        handleWebSocketMessage(message)
      }

      websocket.value.onclose = () => {
        isConnected.value = false
        activeUsers.value = []
        console.log('Disconnected from collaboration server')
        
        // Auto-reconnect after 3 seconds
        setTimeout(() => connectWebSocket(), 3000)
      }

      websocket.value.onerror = (error) => {
        console.error('WebSocket error:', error)
      }
    } catch (error) {
      console.error('Failed to connect WebSocket:', error)
    }
  }

  function disconnectWebSocket() {
    if (websocket.value) {
      websocket.value.close()
      websocket.value = null
    }
    isConnected.value = false
    activeUsers.value = []
  }

  // WebSocket message handling
  function handleWebSocketMessage(message: WebSocketMessage) {
    switch (message.type) {
      case 'room_state':
        activeUsers.value = message.data.users || []
        // Load annotations from room state if available
        if (message.data.annotations) {
          annotations.value = message.data.annotations
        }
        break
        
      case 'user_joined':
        if (!activeUsers.value.find(u => u.id === message.data.id)) {
          activeUsers.value.push(message.data)
        }
        break
        
      case 'user_left':
        activeUsers.value = activeUsers.value.filter(u => u.id !== message.data.id)
        break
        
      case 'annotation_added':
        const newAnnotation = message.data.annotation
        if (!annotations.value.find(a => a.id === newAnnotation.id)) {
          annotations.value.push(newAnnotation)
        }
        break
        
      case 'annotation_updated':
        const updatedAnnotation = message.data.annotation
        const index = annotations.value.findIndex(a => a.id === updatedAnnotation.id)
        if (index !== -1) {
          annotations.value[index] = updatedAnnotation
        }
        break
        
      default:
        console.log('Unknown message type:', message.type)
    }
  }

  function joinRoom(url: string) {
    if (!websocket.value || websocket.value.readyState !== WebSocket.OPEN) return

    const message = {
      type: 'join_room',
      data: {
        url: url,
        user: currentUser.value
      }
    }

    websocket.value.send(JSON.stringify(message))
  }

  function sendWebSocketMessage(type: string, data: any) {
    if (websocket.value && websocket.value.readyState === WebSocket.OPEN) {
      websocket.value.send(JSON.stringify({ type, data }))
    }
  }

  // REST API calls
  async function loadAnnotationsForURL(url: string) {
    try {
      const response = await fetch(`http://localhost:8080/v1/annotations?url=${encodeURIComponent(url)}`)
      if (response.ok) {
        const data = await response.json()
        annotations.value = data.annotations || []
      }
    } catch (error) {
      console.error('Failed to load annotations:', error)
    }
  }

  async function createAnnotation(annotationData: Partial<Annotation>) {
    try {
      const response = await fetch('http://localhost:8080/v1/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...annotationData,
          author: currentUser.value.name,
          url: currentURL.value
        })
      })

      if (response.ok) {
        const annotation = await response.json()
        annotations.value.push(annotation)
        
        // Broadcast via WebSocket
        sendWebSocketMessage('annotation_added', { annotation, user: currentUser.value })
        
        return annotation
      }
    } catch (error) {
      console.error('Failed to create annotation:', error)
    }
  }

  async function resolveAnnotation(id: string) {
    try {
      const response = await fetch(`http://localhost:8080/v1/annotations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: true })
      })

      if (response.ok) {
        const annotation = await response.json()
        const index = annotations.value.findIndex(a => a.id === id)
        if (index !== -1) {
          annotations.value[index] = annotation
        }
        
        // Broadcast update via WebSocket
        sendWebSocketMessage('annotation_updated', { annotation, user: currentUser.value })
      }
    } catch (error) {
      console.error('Failed to resolve annotation:', error)
    }
  }

  // Utilities
  function normalizeURL(url: string): string {
    try {
      const parsed = new URL(url)
      parsed.hash = ''
      
      // Remove tracking parameters
      const paramsToRemove = ['utm_source', 'utm_medium', 'sessionId', '_ga', '_gid']
      paramsToRemove.forEach(param => parsed.searchParams.delete(param))
      
      // Sort remaining params
      const sortedParams = Array.from(parsed.searchParams.entries()).sort()
      parsed.search = ''
      if (sortedParams.length > 0) {
        parsed.search = '?' + sortedParams.map(([k, v]) => `${k}=${v}`).join('&')
      }
      
      return parsed.toString()
    } catch {
      return url
    }
  }

  return {
    // State
    currentUser,
    activeUsers,
    annotations,
    currentURL,
    isConnected,
    annotationMode,
    
    // Getters
    annotationsForCurrentURL,
    activeUserCount,
    
    // Actions
    setCurrentUser,
    setIframeRef,
    setCurrentURL,
    setAnnotationMode,
    connectWebSocket,
    disconnectWebSocket,
    loadAnnotationsForURL,
    createAnnotation,
    resolveAnnotation,
    joinRoom,
    sendWebSocketMessage
  }
})