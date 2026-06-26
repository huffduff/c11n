package annotation

import (
	"context"
	"errors"
	"sync"

	"github.com/huffduff/c11n/backend/pkg/models"
)

// Service handles annotation business logic
type Service struct {
	storage map[string][]models.Annotation // URL -> annotations mapping
	mu      sync.RWMutex
}

func NewService() *Service {
	return &Service{
		storage: make(map[string][]models.Annotation),
	}
}

// GetAnnotationsForURL returns all non-resolved annotations for a URL
func (s *Service) GetAnnotationsForURL(ctx context.Context, url string) []models.Annotation {
	s.mu.RLock()
	defer s.mu.RUnlock()
	
	annotations := s.storage[url]
	
	// Filter out resolved annotations (optional - could be configurable)
	var active []models.Annotation
	for _, annotation := range annotations {
		if !annotation.Resolved {
			active = append(active, annotation)
		}
	}
	
	return active
}

// CreateAnnotation adds a new annotation and broadcasts to WebSocket clients
func (s *Service) CreateAnnotation(ctx context.Context, annotation models.Annotation) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	
	// Add to storage
	s.storage[annotation.URL] = append(s.storage[annotation.URL], annotation)
	
	// TODO: Broadcast to WebSocket clients in the same URL room
	// This would trigger a WebSocket message to all connected clients viewing this URL
	
	return nil
}

// UpdateAnnotation modifies an existing annotation
func (s *Service) UpdateAnnotation(ctx context.Context, id string, req UpdateAnnotationRequest) (*models.Annotation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	
	// Find the annotation across all URLs
	for url, annotations := range s.storage {
		for i, annotation := range annotations {
			if annotation.ID == id {
				// Update fields
				if req.Text != nil {
					annotation.Text = *req.Text
				}
				if req.Resolved != nil {
					annotation.Resolved = *req.Resolved
				}
				
				// Save back to storage
				s.storage[url][i] = annotation
				
				// TODO: Broadcast update to WebSocket clients
				
				return &annotation, nil
			}
		}
	}
	
	return nil, errors.New("annotation not found")
}

// DeleteAnnotation removes an annotation
func (s *Service) DeleteAnnotation(ctx context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	
	// Find and remove the annotation
	for url, annotations := range s.storage {
		for i, annotation := range annotations {
			if annotation.ID == id {
				// Remove from slice
				s.storage[url] = append(annotations[:i], annotations[i+1:]...)
				
				// TODO: Broadcast deletion to WebSocket clients
				
				return nil
			}
		}
	}
	
	return errors.New("annotation not found")
}

// GetAllAnnotations returns all annotations (for admin/debugging)
func (s *Service) GetAllAnnotations(ctx context.Context) map[string][]models.Annotation {
	s.mu.RLock()
	defer s.mu.RUnlock()
	
	// Return a copy to prevent external modification
	result := make(map[string][]models.Annotation)
	for url, annotations := range s.storage {
		result[url] = make([]models.Annotation, len(annotations))
		copy(result[url], annotations)
	}
	
	return result
}