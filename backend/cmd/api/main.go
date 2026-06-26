package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/huffduff/c11n/backend/internal/annotation"
	"github.com/huffduff/c11n/backend/internal/config"
	"github.com/huffduff/c11n/backend/internal/server"
	"github.com/huffduff/c11n/backend/internal/websocket"
	"github.com/joho/godotenv"
)

func main() {
	// Load environment variables
	if err := godotenv.Load(); err != nil && os.Getenv("APP_ENV") != "production" {
		log.Println("Warning: .env file not found")
	}

	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		log.Fatal("Failed to load config:", err)
	}

	log.Printf("Starting c11n collaboration server in %s mode", cfg.AppEnv)

	// Initialize services
	annotationService := annotation.NewService()
	wsHandler := websocket.NewHandler()

	// Initialize handlers
	annotationHandler := annotation.NewHandler(annotationService)

	// Setup router
	router := server.NewRouter(annotationHandler, wsHandler)

	// Create server
	srv := server.New(":"+cfg.Port, router)

	// Start server with graceful shutdown
	go func() {
		log.Printf("c11n server starting on port %s", cfg.Port)
		log.Printf("WebSocket endpoint: ws://localhost:%s/ws", cfg.Port)
		log.Printf("REST API: http://localhost:%s/v1", cfg.Port)
		log.Printf("Health check: http://localhost:%s/health", cfg.Port)
		
		if err := srv.Start(); err != nil {
			log.Fatal("Server failed to start:", err)
		}
	}()

	// Wait for interrupt signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("c11n server shutting down...")
	if err := srv.Shutdown(context.Background()); err != nil {
		log.Fatal("Server forced to shutdown:", err)
	}
	log.Println("c11n server exited")
}