# c11n - Real-time Collaboration for Web App Reviews

c11n (pronounced "collaboration") is a real-time web application review and annotation tool that enables teams to provide feedback on live web applications through DOM-based annotations and collaborative discussions.

## Architecture

This is a monorepo containing:

- **`frontend/`** - Vue 3 + TypeScript collaborative review interface
- **`backend/`** - Go HTTP server with WebSocket support for real-time collaboration

## Key Features

- **DOM Element Targeting**: Annotations target DOM elements via CSS selectors, not screen coordinates
- **URL-Based Persistence**: Comments persist across page navigation within the reviewed application
- **Real-time Collaboration**: Live cursor presence, annotations, and discussions
- **iframe Integration**: Reviews any web application through iframe embedding with script injection

## Quick Start

### Frontend (Vue 3)
```bash
cd frontend
npm install
npm run dev
```

### Backend (Go)
```bash
cd backend
go mod tidy
go run cmd/api/main.go
```

## How It Works

1. **Target Application**: Load any web app in an iframe
2. **Script Injection**: Automatically inject annotation capabilities via JavaScript
3. **DOM Targeting**: Click elements to create annotations using CSS selectors
4. **Real-time Sync**: WebSocket connections sync annotations across all users
5. **URL Persistence**: Navigate the app while maintaining annotation context

## Technical Architecture

- **Frontend**: Vue 3 composition API with real-time WebSocket synchronization
- **Backend**: Go with Chi router, WebSocket rooms organized by URL
- **Annotation Storage**: DOM selector-based with URL indexing for fast retrieval
- **Real-time**: WebSocket rooms partitioned by reviewed URL for performance

## Development Status

🚧 **In Development** - Core architecture established, implementing features incrementally

## License

MIT