// Frontend JavaScript for DOM element targeting and annotation
// This gets injected into the iframe target application

class AnnotationManager {
  constructor(apiBaseURL, wsURL) {
    this.apiBaseURL = apiBaseURL;
    this.wsURL = wsURL;
    this.annotations = new Map(); // selector -> annotation data
    this.annotationMode = false;
    this.websocket = null;
    this.currentUser = null;
    
    this.init();
  }

  init() {
    this.addAnnotationStyles();
    this.setupEventListeners();
    this.connectWebSocket();
  }

  // Generate CSS selector path for reliable DOM targeting
  generateSelector(element) {
    let path = [];
    let current = element;
    
    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();
      
      // Add ID if present (most stable)
      if (current.id) {
        selector += `#${current.id}`;
        path.unshift(selector);
        break; // ID is unique, we can stop here
      }
      
      // Add classes for specificity
      if (current.className) {
        const classes = current.className.trim().split(/\s+/).filter(c => c.length > 0);
        if (classes.length > 0) {
          selector += '.' + classes.join('.');
        }
      }
      
      // Add nth-child if needed for uniqueness
      const siblings = Array.from(current.parentElement?.children || []);
      const sameTagSiblings = siblings.filter(s => s.tagName === current.tagName);
      if (sameTagSiblings.length > 1) {
        const index = sameTagSiblings.indexOf(current) + 1;
        selector += `:nth-of-type(${index})`;
      }
      
      path.unshift(selector);
      current = current.parentElement;
    }
    
    return path.join(' > ');
  }

  // Normalize URL for consistent storage/lookup
  normalizeURL(url) {
    const parsed = new URL(url);
    parsed.hash = '';
    
    // Remove session/tracking params
    const paramsToRemove = ['utm_source', 'utm_medium', 'sessionId', '_ga', '_gid'];
    paramsToRemove.forEach(param => parsed.searchParams.delete(param));
    
    // Sort remaining params
    const sortedParams = [];
    for (const [key, value] of parsed.searchParams.entries()) {
      sortedParams.push([key, value]);
    }
    sortedParams.sort();
    
    parsed.search = '';
    if (sortedParams.length > 0) {
      parsed.search = '?' + sortedParams.map(([k, v]) => `${k}=${v}`).join('&');
    }
    
    return parsed.toString();
  }

  // Enable/disable annotation mode
  setAnnotationMode(enabled) {
    this.annotationMode = enabled;
    document.body.classList.toggle('c11n-annotation-mode', enabled);
  }

  // Setup event listeners for DOM interaction
  setupEventListeners() {
    document.addEventListener('click', (e) => {
      if (this.annotationMode) {
        e.preventDefault();
        e.stopPropagation();
        this.createAnnotation(e.target);
      }
    }, true);

    // URL change detection for SPA support
    let currentURL = this.normalizeURL(window.location.href);
    
    const detectURLChange = () => {
      const newURL = this.normalizeURL(window.location.href);
      if (newURL !== currentURL) {
        currentURL = newURL;
        this.loadAnnotationsForURL(newURL);
      }
    };

    // Listen for URL changes
    window.addEventListener('popstate', detectURLChange);
    
    // MutationObserver for programmatic navigation
    const observer = new MutationObserver(detectURLChange);
    observer.observe(document, { subtree: true, childList: true });
  }

  // Create annotation for a DOM element
  async createAnnotation(element) {
    const selector = this.generateSelector(element);
    const rect = element.getBoundingClientRect();
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    
    const annotationData = {
      url: this.normalizeURL(window.location.href),
      selector: selector,
      text: await this.promptForComment(),
      author: this.currentUser?.name || 'Anonymous',
      element_html: element.outerHTML,
      bounding_box: {
        x: rect.left,
        y: rect.top + scrollTop,
        width: rect.width,
        height: rect.height
      },
      selector_data: {
        primary: selector,
        fallback: element.tagName.toLowerCase(),
        text: element.textContent?.slice(0, 50) || ''
      }
    };

    try {
      const response = await fetch(`${this.apiBaseURL}/v1/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(annotationData)
      });

      if (response.ok) {
        const annotation = await response.json();
        this.displayAnnotation(annotation);
        
        // Broadcast via WebSocket
        this.sendWebSocketMessage('annotation_added', annotation);
      }
    } catch (error) {
      console.error('Failed to create annotation:', error);
    }
  }

  // Prompt user for annotation text
  async promptForComment() {
    return new Promise((resolve) => {
      const comment = prompt('Add your comment:');
      resolve(comment || 'No comment');
    });
  }

  // Display annotation visually on the page  
  displayAnnotation(annotation) {
    try {
      const element = document.querySelector(annotation.selector);
      if (!element) {
        console.warn('Cannot find element for selector:', annotation.selector);
        return;
      }

      // Create annotation marker
      const marker = document.createElement('div');
      marker.className = 'c11n-annotation-marker';
      marker.dataset.annotationId = annotation.id;
      marker.textContent = '💬';
      
      // Position relative to element
      const rect = element.getBoundingClientRect();
      marker.style.cssText = `
        position: absolute;
        top: ${rect.top + window.scrollY - 10}px;
        left: ${rect.right + 5}px;
        z-index: 10000;
        background: ${annotation.user?.color || '#007bff'};
        color: white;
        border-radius: 50%;
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      `;

      // Add click handler to show comment
      marker.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showAnnotationPopup(annotation, marker);
      });

      document.body.appendChild(marker);
      
      // Store reference
      this.annotations.set(annotation.selector, { annotation, marker });
      
      // Highlight target element
      element.classList.add('c11n-annotated-element');

    } catch (error) {
      console.error('Error displaying annotation:', error);
    }
  }

  // Show annotation popup
  showAnnotationPopup(annotation, marker) {
    // Remove existing popup
    const existingPopup = document.querySelector('.c11n-annotation-popup');
    if (existingPopup) existingPopup.remove();

    const popup = document.createElement('div');
    popup.className = 'c11n-annotation-popup';
    popup.innerHTML = `
      <div class="c11n-popup-header">
        <strong>${annotation.author}</strong>
        <span class="c11n-popup-close">×</span>
      </div>
      <div class="c11n-popup-content">
        ${annotation.text}
      </div>
      <div class="c11n-popup-footer">
        ${new Date(annotation.created).toLocaleString()}
      </div>
    `;

    popup.style.cssText = `
      position: absolute;
      background: white;
      border: 1px solid #ddd;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 10001;
      min-width: 200px;
      max-width: 300px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px;
    `;

    // Position near marker
    const markerRect = marker.getBoundingClientRect();
    popup.style.top = (markerRect.bottom + window.scrollY + 5) + 'px';
    popup.style.left = markerRect.left + 'px';

    // Close button
    popup.querySelector('.c11n-popup-close').addEventListener('click', () => {
      popup.remove();
    });

    document.body.appendChild(popup);
  }

  // Load annotations for current URL
  async loadAnnotationsForURL(url) {
    try {
      const response = await fetch(`${this.apiBaseURL}/v1/annotations?url=${encodeURIComponent(url)}`);
      if (response.ok) {
        const data = await response.json();
        
        // Clear existing annotations
        this.clearAnnotations();
        
        // Display loaded annotations
        data.annotations.forEach(annotation => {
          this.displayAnnotation(annotation);
        });
      }
    } catch (error) {
      console.error('Failed to load annotations:', error);
    }
  }

  // Clear all annotation markers
  clearAnnotations() {
    document.querySelectorAll('.c11n-annotation-marker').forEach(el => el.remove());
    document.querySelectorAll('.c11n-annotation-popup').forEach(el => el.remove());
    document.querySelectorAll('.c11n-annotated-element').forEach(el => {
      el.classList.remove('c11n-annotated-element');
    });
    this.annotations.clear();
  }

  // WebSocket connection for real-time collaboration
  connectWebSocket() {
    try {
      this.websocket = new WebSocket(this.wsURL);
      
      this.websocket.onopen = () => {
        console.log('Connected to c11n collaboration server');
        
        // Join room for current URL
        this.joinRoom();
      };

      this.websocket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        this.handleWebSocketMessage(message);
      };

      this.websocket.onclose = () => {
        console.log('Disconnected from c11n collaboration server');
        // Auto-reconnect after 3 seconds
        setTimeout(() => this.connectWebSocket(), 3000);
      };
    } catch (error) {
      console.error('WebSocket connection failed:', error);
    }
  }

  // Join WebSocket room for current URL
  joinRoom() {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) return;

    const joinMessage = {
      type: 'join_room',
      data: {
        url: this.normalizeURL(window.location.href),
        user: this.currentUser || {
          id: 'user_' + Math.random().toString(36).substr(2, 9),
          name: 'Anonymous User',
          email: '',
        }
      }
    };

    this.websocket.send(JSON.stringify(joinMessage));
  }

  // Handle incoming WebSocket messages
  handleWebSocketMessage(message) {
    switch (message.type) {
      case 'room_state':
        console.log('Joined room:', message.data.url);
        console.log('Users in room:', message.data.users);
        break;
        
      case 'user_joined':
        console.log('User joined:', message.data.name);
        break;
        
      case 'user_left':
        console.log('User left:', message.data.name);
        break;
        
      case 'annotation_added':
        this.displayAnnotation(message.data.annotation);
        break;
        
      default:
        console.log('Unknown message type:', message.type);
    }
  }

  // Send WebSocket message
  sendWebSocketMessage(type, data) {
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify({ type, data }));
    }
  }

  // Add CSS styles for annotations
  addAnnotationStyles() {
    if (document.getElementById('c11n-annotation-styles')) return;

    const styles = document.createElement('style');
    styles.id = 'c11n-annotation-styles';
    styles.textContent = `
      .c11n-annotation-mode {
        cursor: crosshair !important;
      }
      
      .c11n-annotation-mode * {
        cursor: crosshair !important;
      }
      
      .c11n-annotated-element {
        outline: 2px solid #007bff !important;
        outline-offset: 2px !important;
      }
      
      .c11n-annotation-marker {
        transition: transform 0.2s ease;
      }
      
      .c11n-annotation-marker:hover {
        transform: scale(1.2);
      }
      
      .c11n-popup-header {
        background: #f8f9fa;
        padding: 8px 12px;
        border-bottom: 1px solid #dee2e6;
        border-radius: 8px 8px 0 0;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      
      .c11n-popup-content {
        padding: 12px;
        line-height: 1.4;
      }
      
      .c11n-popup-footer {
        padding: 8px 12px;
        background: #f8f9fa;
        border-top: 1px solid #dee2e6;
        border-radius: 0 0 8px 8px;
        font-size: 12px;
        color: #6c757d;
      }
      
      .c11n-popup-close {
        cursor: pointer;
        font-size: 16px;
        color: #6c757d;
        font-weight: bold;
      }
      
      .c11n-popup-close:hover {
        color: #dc3545;
      }
    `;
    
    document.head.appendChild(styles);
  }

  // Set current user (called from parent frame)
  setUser(user) {
    this.currentUser = user;
    
    // Rejoin room with new user info
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      this.joinRoom();
    }
  }
}

// Global initialization
window.c11nAnnotationManager = new AnnotationManager(
  'http://localhost:8080', // API base URL
  'ws://localhost:8080/ws' // WebSocket URL
);

// Expose methods for parent frame communication
window.c11nAPI = {
  setAnnotationMode: (enabled) => window.c11nAnnotationManager.setAnnotationMode(enabled),
  setUser: (user) => window.c11nAnnotationManager.setUser(user),
  loadAnnotationsForURL: (url) => window.c11nAnnotationManager.loadAnnotationsForURL(url)
};