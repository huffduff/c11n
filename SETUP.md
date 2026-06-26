# c11n Development Setup

## Quick Start

### Prerequisites
- Node.js 18+ (for frontend)
- Go 1.21+ (for backend)

### 1. Frontend Setup
```bash
cd frontend
npm install
npm run dev
# Frontend runs on http://localhost:5173
```

### 2. Backend Setup
```bash
cd backend
cp .env.example .env
go mod tidy
go run cmd/api/main.go
# Backend runs on http://localhost:8080
```

### 3. Usage
1. Open http://localhost:5173 in your browser
2. Enter a website URL (e.g., https://example.com)
3. Click "Start Annotating" to enable comment mode
4. Click on elements in the iframe to add comments
5. Comments are shared in real-time with other users

## Project Structure

```
c11n/
├── frontend/                 # Vue 3 + TypeScript frontend
│   ├── src/
│   │   ├── App.vue          # Main collaboration interface
│   │   ├── stores/          
│   │   │   └── collaboration.ts  # Pinia store for real-time state
│   │   └── main.ts
│   └── public/
│       └── annotation-inject.js  # Script injected into target websites
│
└── backend/                 # Go backend with WebSocket support
    ├── cmd/api/main.go      # HTTP server entry point
    ├── internal/
    │   ├── config/          # Environment configuration
    │   ├── server/          # HTTP router and middleware
    │   ├── annotation/      # Annotation REST API handlers
    │   └── websocket/       # Real-time WebSocket handling
    ├── pkg/
    │   ├── models/          # Shared data types
    │   └── utils/           # Utility functions
    └── go.mod
```

## Key Features Implemented

### 🎯 DOM Element Targeting
- **CSS Selector Generation**: Creates reliable selectors like `header > nav > button.login-btn`
- **Fallback Strategies**: Multiple targeting approaches for robustness
- **Element Highlighting**: Visual feedback when annotating

### 🌐 URL-Based Persistence  
- **Normalized URLs**: Removes tracking parameters, sorts query params consistently
- **Cross-Page Navigation**: Comments persist as users navigate the target app
- **SPA Detection**: Handles programmatic navigation via MutationObserver

### ⚡ Real-Time Collaboration
- **WebSocket Rooms**: Users automatically join rooms based on current URL
- **Live Presence**: See who else is reviewing the same page
- **Instant Updates**: Annotations broadcast immediately to all room participants

### 🖥️ iframe Integration
- **Script Injection**: Automatically adds annotation capabilities to any website
- **Cross-Origin Handling**: Graceful degradation when security prevents injection
- **Event Communication**: Parent-iframe messaging for seamless UX

## Technical Architecture

### Frontend (Vue 3)
- **Composition API** with TypeScript for type safety
- **Pinia Store** for centralized state management
- **WebSocket Client** for real-time updates
- **iframe Communication** via postMessage API

### Backend (Go)
- **Chi Router** for HTTP routing with middleware
- **WebSocket Rooms** organized by normalized URLs  
- **In-Memory Storage** (easily replaceable with database)
- **CORS Support** for iframe and cross-origin requests

### Data Flow
```
User clicks element in iframe
    ↓
Generate CSS selector
    ↓
POST to REST API (/v1/annotations)
    ↓
Store annotation with normalized URL
    ↓
Broadcast via WebSocket to room
    ↓
All users see annotation in real-time
```

## Code Snippets Integration

All the code snippets we discussed are implemented:

### DOM Element Targeting
- **`generateSelector()`** in `annotation-inject.js`
- **Fallback selectors** with primary/secondary targeting
- **Element highlighting** and visual feedback

### URL Normalization  
- **`normalizeURL()`** in both frontend and backend
- **Parameter filtering** removes tracking/session params
- **Consistent indexing** for annotation lookup

### WebSocket Real-time Sync
- **Room-based architecture** in `websocket/handler.go`
- **Message broadcasting** to all room participants  
- **User presence tracking** with join/leave events

### Annotation Storage
- **REST API** in `annotation/handler.go`
- **Business logic** in `annotation/service.go`
- **WebSocket integration** for real-time updates

## Development Status

✅ **Core Infrastructure**: Complete monorepo setup with Vue + Go  
✅ **DOM Targeting**: CSS selector generation with fallbacks  
✅ **Real-time Sync**: WebSocket rooms and message broadcasting  
✅ **URL Persistence**: Normalized URL indexing and cross-page navigation  
✅ **iframe Integration**: Script injection and parent communication  
✅ **REST API**: Full CRUD operations for annotations  

🚧 **Next Steps**:
- Database integration (replace in-memory storage)
- User authentication and authorization
- Annotation threading and replies
- Visual annotation indicators (arrows, highlights)
- Mobile responsive design
- Performance optimization for large annotation sets

## Testing

### Manual Testing Flow
1. Start both frontend and backend servers
2. Open collaboration interface at http://localhost:5173
3. Load a test website (start with https://example.com)
4. Enable annotation mode and click elements
5. Open second browser tab to test real-time sync
6. Navigate around target site to test URL persistence

### API Testing
```bash
# Get annotations for a URL
curl "http://localhost:8080/v1/annotations?url=https://example.com"

# Create annotation  
curl -X POST http://localhost:8080/v1/annotations \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","selector":"h1","text":"Test comment","author":"Test User"}'

# Health check
curl http://localhost:8080/health
```

## Deployment Considerations

### Frontend
- Build with `npm run build`
- Serve static files from `dist/`
- Configure base URL for API endpoints

### Backend  
- Compile with `go build cmd/api/main.go`
- Set environment variables from `.env.example`
- Consider using database instead of in-memory storage
- Configure CORS for production domains

### Infrastructure
- **WebSocket load balancing** requires session affinity
- **Database** for annotation persistence (PostgreSQL recommended)
- **Redis** for WebSocket scaling across multiple instances
- **CDN** for frontend static assets

This implementation provides a solid foundation for real-time web application collaboration with DOM-based annotations!