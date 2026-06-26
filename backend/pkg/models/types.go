package models

import (
	"time"
)

// Annotation represents a comment/annotation on a specific DOM element
type Annotation struct {
	ID       string    `json:"id"`
	URL      string    `json:"url"`         // Normalized URL where annotation was made
	Selector string    `json:"selector"`    // CSS selector targeting the element
	Text     string    `json:"text"`        // Comment text
	Author   string    `json:"author"`
	Created  time.Time `json:"created"`
	Resolved bool      `json:"resolved"`
	
	// Additional metadata
	ElementHTML  string            `json:"element_html,omitempty"`  // For debugging/context
	BoundingBox  *BoundingBox      `json:"bounding_box,omitempty"`  // Visual positioning
	SelectorData *SelectorFallback `json:"selector_data,omitempty"` // Fallback selectors
}

// BoundingBox represents the visual position of an element (for UI positioning)
type BoundingBox struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// SelectorFallback provides multiple ways to target an element
type SelectorFallback struct {
	Primary  string `json:"primary"`           // Main CSS selector
	Fallback string `json:"fallback"`          // Alternative selector
	Text     string `json:"text,omitempty"`    // Text content fallback
}

// User represents a connected user
type User struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Email    string    `json:"email,omitempty"`
	Color    string    `json:"color"`    // For UI representation
	JoinedAt time.Time `json:"joined_at"`
}

// WebSocketMessage represents real-time communication
type WebSocketMessage struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

// Message types
const (
	MessageTypeJoinRoom        = "join_room"
	MessageTypeLeaveRoom       = "leave_room"
	MessageTypeAnnotationAdded = "annotation_added"
	MessageTypeAnnotationUpdated = "annotation_updated"
	MessageTypeAnnotationResolved = "annotation_resolved"
	MessageTypeUserJoined      = "user_joined"
	MessageTypeUserLeft        = "user_left"
	MessageTypeRoomState       = "room_state"
)

// Room state messages
type JoinRoomRequest struct {
	URL  string `json:"url"`
	User User   `json:"user"`
}

type RoomState struct {
	URL         string       `json:"url"`
	Users       []User       `json:"users"`
	Annotations []Annotation `json:"annotations"`
}

// Annotation messages
type AnnotationEvent struct {
	Annotation Annotation `json:"annotation"`
	User       User       `json:"user"`
}