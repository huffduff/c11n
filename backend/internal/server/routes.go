package server

import (
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/huffduff/c11n/backend/internal/annotation"
	"github.com/huffduff/c11n/backend/internal/websocket"
)

func NewRouter(annotationHandler *annotation.Handler, wsHandler *websocket.Handler) chi.Router {
	r := chi.NewRouter()
	
	// Global middleware
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.RequestID)
	r.Use(CORSMiddleware()) // Custom CORS for iframe support
	
	// API routes
	r.Route("/v1", func(r chi.Router) {
		// Annotation REST API
		r.Route("/annotations", func(r chi.Router) {
			r.Get("/", annotationHandler.List)        // GET /v1/annotations?url=...
			r.Post("/", annotationHandler.Create)     // POST /v1/annotations
			r.Put("/{id}", annotationHandler.Update)  // PUT /v1/annotations/{id}
			r.Delete("/{id}", annotationHandler.Delete) // DELETE /v1/annotations/{id}
		})
	})
	
	// WebSocket endpoint for real-time collaboration
	r.Get("/ws", wsHandler.HandleWebSocket)
	
	// Health check
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})
	
	return r
}