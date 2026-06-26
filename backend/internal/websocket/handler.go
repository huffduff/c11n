package websocket

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/huffduff/c11n/backend/pkg/models"
	"github.com/huffduff/c11n/backend/pkg/utils"
)

// Handler manages WebSocket connections and real-time collaboration
type Handler struct {
	rooms       map[string]*Room           // URL -> Room mapping
	connections map[string]*Connection     // Connection ID -> Connection
	mu          sync.RWMutex
}

// Room represents a collaboration session for a specific URL
type Room struct {
	URL         string                    `json:"url"`
	Users       map[string]*models.User   `json:"users"`       // User ID -> User
	Connections map[string]*Connection    `json:"connections"` // Connection ID -> Connection
	Created     time.Time                 `json:"created"`
}

// Connection represents a WebSocket connection
type Connection struct {
	ID     string          `json:"id"`
	User   models.User     `json:"user"`
	Conn   *websocket.Conn `json:"-"`
	Room   *Room           `json:"-"`
	Send   chan []byte     `json:"-"`
}

func NewHandler() *Handler {
	return &Handler{
		rooms:       make(map[string]*Room),
		connections: make(map[string]*Connection),
	}
}

// HandleWebSocket upgrades HTTP connection to WebSocket
func (h *Handler) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"}, // Allow all origins for iframe support
	})
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}
	defer conn.Close(websocket.StatusInternalError, "connection closed")

	// Create connection
	connectionID := uuid.New().String()
	connection := &Connection{
		ID:   connectionID,
		Conn: conn,
		Send: make(chan []byte, 256),
	}

	h.mu.Lock()
	h.connections[connectionID] = connection
	h.mu.Unlock()

	// Remove connection on disconnect
	defer func() {
		h.mu.Lock()
		delete(h.connections, connectionID)
		if connection.Room != nil {
			h.leaveRoom(connection)
		}
		h.mu.Unlock()
		close(connection.Send)
	}()

	// Start message pump
	go h.writePump(connection)
	h.readPump(connection)
}

// readPump handles incoming WebSocket messages
func (h *Handler) readPump(conn *Connection) {
	defer conn.Conn.Close(websocket.StatusInternalError, "read pump closed")

	for {
		_, message, err := conn.Conn.Read(context.Background())
		if err != nil {
			log.Printf("WebSocket read error: %v", err)
			break
		}

		var msg models.WebSocketMessage
		if err := json.Unmarshal(message, &msg); err != nil {
			log.Printf("JSON unmarshal error: %v", err)
			continue
		}

		h.handleMessage(conn, msg)
	}
}

// writePump handles outgoing WebSocket messages
func (h *Handler) writePump(conn *Connection) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case message, ok := <-conn.Send:
			if !ok {
				conn.Conn.Close(websocket.StatusInternalError, "send channel closed")
				return
			}

			if err := conn.Conn.Write(context.Background(), websocket.MessageText, message); err != nil {
				log.Printf("WebSocket write error: %v", err)
				return
			}

		case <-ticker.C:
			if err := conn.Conn.Ping(context.Background()); err != nil {
				log.Printf("WebSocket ping error: %v", err)
				return
			}
		}
	}
}

// handleMessage processes incoming WebSocket messages
func (h *Handler) handleMessage(conn *Connection, msg models.WebSocketMessage) {
	switch msg.Type {
	case models.MessageTypeJoinRoom:
		h.handleJoinRoom(conn, msg)
	case models.MessageTypeLeaveRoom:
		h.handleLeaveRoom(conn, msg)
	case models.MessageTypeAnnotationAdded:
		h.handleAnnotationAdded(conn, msg)
	default:
		log.Printf("Unknown message type: %s", msg.Type)
	}
}

// handleJoinRoom adds a user to a URL-based room
func (h *Handler) handleJoinRoom(conn *Connection, msg models.WebSocketMessage) {
	var req models.JoinRoomRequest
	data, _ := json.Marshal(msg.Data)
	if err := json.Unmarshal(data, &req); err != nil {
		log.Printf("Join room unmarshal error: %v", err)
		return
	}

	normalizedURL, err := utils.NormalizeURL(req.URL)
	if err != nil {
		log.Printf("URL normalization error: %v", err)
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	// Get or create room
	room := h.rooms[normalizedURL]
	if room == nil {
		room = &Room{
			URL:         normalizedURL,
			Users:       make(map[string]*models.User),
			Connections: make(map[string]*Connection),
			Created:     time.Now(),
		}
		h.rooms[normalizedURL] = room
	}

	// Set user color if not provided
	if req.User.Color == "" {
		req.User.Color = utils.GenerateUserColor(req.User.ID)
	}
	req.User.JoinedAt = time.Now()

	// Add user to room
	room.Users[req.User.ID] = &req.User
	room.Connections[conn.ID] = conn
	conn.User = req.User
	conn.Room = room

	// Send current room state to new user
	roomState := models.RoomState{
		URL:         normalizedURL,
		Users:       make([]models.User, 0, len(room.Users)),
		Annotations: []models.Annotation{}, // TODO: Load from annotation service
	}

	for _, user := range room.Users {
		roomState.Users = append(roomState.Users, *user)
	}

	h.sendMessage(conn, models.MessageTypeRoomState, roomState)

	// Notify other users about the new user
	h.broadcastToRoom(room, models.MessageTypeUserJoined, req.User, conn.ID)
}

// handleLeaveRoom removes a user from their current room
func (h *Handler) handleLeaveRoom(conn *Connection, msg models.WebSocketMessage) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if conn.Room != nil {
		h.leaveRoom(conn)
	}
}

// leaveRoom internal helper (assumes lock is held)
func (h *Handler) leaveRoom(conn *Connection) {
	room := conn.Room
	if room == nil {
		return
	}

	// Remove user and connection from room
	delete(room.Users, conn.User.ID)
	delete(room.Connections, conn.ID)

	// Notify remaining users
	h.broadcastToRoom(room, models.MessageTypeUserLeft, conn.User, conn.ID)

	// Clean up empty rooms
	if len(room.Connections) == 0 {
		delete(h.rooms, room.URL)
	}

	conn.Room = nil
}

// handleAnnotationAdded broadcasts new annotations to room users
func (h *Handler) handleAnnotationAdded(conn *Connection, msg models.WebSocketMessage) {
	if conn.Room == nil {
		return
	}

	var annotation models.Annotation
	data, _ := json.Marshal(msg.Data)
	if err := json.Unmarshal(data, &annotation); err != nil {
		log.Printf("Annotation unmarshal error: %v", err)
		return
	}

	event := models.AnnotationEvent{
		Annotation: annotation,
		User:       conn.User,
	}

	h.mu.RLock()
	h.broadcastToRoom(conn.Room, models.MessageTypeAnnotationAdded, event, conn.ID)
	h.mu.RUnlock()
}

// broadcastToRoom sends a message to all connections in a room except the sender
func (h *Handler) broadcastToRoom(room *Room, messageType string, data interface{}, excludeConnID string) {
	message, err := json.Marshal(models.WebSocketMessage{
		Type: messageType,
		Data: data,
	})
	if err != nil {
		log.Printf("Message marshal error: %v", err)
		return
	}

	for connID, conn := range room.Connections {
		if connID != excludeConnID {
			select {
			case conn.Send <- message:
			default:
				close(conn.Send)
				delete(room.Connections, connID)
			}
		}
	}
}

// sendMessage sends a message to a specific connection
func (h *Handler) sendMessage(conn *Connection, messageType string, data interface{}) {
	message, err := json.Marshal(models.WebSocketMessage{
		Type: messageType,
		Data: data,
	})
	if err != nil {
		log.Printf("Message marshal error: %v", err)
		return
	}

	select {
	case conn.Send <- message:
	default:
		close(conn.Send)
		if conn.Room != nil {
			delete(conn.Room.Connections, conn.ID)
		}
	}
}

// GetRoomStats returns statistics about active rooms (for debugging/monitoring)
func (h *Handler) GetRoomStats() map[string]interface{} {
	h.mu.RLock()
	defer h.mu.RUnlock()

	stats := make(map[string]interface{})
	stats["total_rooms"] = len(h.rooms)
	stats["total_connections"] = len(h.connections)

	rooms := make([]map[string]interface{}, 0, len(h.rooms))
	for url, room := range h.rooms {
		rooms = append(rooms, map[string]interface{}{
			"url":             url,
			"user_count":      len(room.Users),
			"connection_count": len(room.Connections),
			"created":         room.Created,
		})
	}
	stats["rooms"] = rooms

	return stats
}