package annotation

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/huffduff/c11n/backend/pkg/models"
	"github.com/huffduff/c11n/backend/pkg/utils"
)

type Handler struct {
	service *Service
}

func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
}

// List returns annotations for a specific URL
// GET /v1/annotations?url=https://example.com/page
func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	rawURL := r.URL.Query().Get("url")
	if rawURL == "" {
		http.Error(w, "url parameter required", http.StatusBadRequest)
		return
	}
	
	normalizedURL, err := utils.NormalizeURL(rawURL)
	if err != nil {
		http.Error(w, "invalid url", http.StatusBadRequest)
		return
	}
	
	annotations := h.service.GetAnnotationsForURL(r.Context(), normalizedURL)
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"annotations": annotations,
		"count":      len(annotations),
	})
}

// Create adds a new annotation
// POST /v1/annotations
func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	var req CreateAnnotationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	
	// Validate required fields
	if req.URL == "" || req.Selector == "" || req.Text == "" || req.Author == "" {
		http.Error(w, "missing required fields: url, selector, text, author", http.StatusBadRequest)
		return
	}
	
	normalizedURL, err := utils.NormalizeURL(req.URL)
	if err != nil {
		http.Error(w, "invalid url", http.StatusBadRequest)
		return
	}
	
	annotation := models.Annotation{
		ID:       uuid.New().String(),
		URL:      normalizedURL,
		Selector: req.Selector,
		Text:     req.Text,
		Author:   req.Author,
		Created:  time.Now(),
		Resolved: false,
		ElementHTML: req.ElementHTML,
		BoundingBox: req.BoundingBox,
		SelectorData: req.SelectorData,
	}
	
	if err := h.service.CreateAnnotation(r.Context(), annotation); err != nil {
		http.Error(w, "failed to create annotation", http.StatusInternalServerError)
		return
	}
	
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(annotation)
}

// Update modifies an existing annotation
// PUT /v1/annotations/{id}
func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		http.Error(w, "annotation id required", http.StatusBadRequest)
		return
	}
	
	var req UpdateAnnotationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	
	annotation, err := h.service.UpdateAnnotation(r.Context(), id, req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(annotation)
}

// Delete removes an annotation
// DELETE /v1/annotations/{id}
func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == "" {
		http.Error(w, "annotation id required", http.StatusBadRequest)
		return
	}
	
	if err := h.service.DeleteAnnotation(r.Context(), id); err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	
	w.WriteHeader(http.StatusNoContent)
}

// Request/Response types
type CreateAnnotationRequest struct {
	URL          string                    `json:"url"`
	Selector     string                    `json:"selector"`
	Text         string                    `json:"text"`
	Author       string                    `json:"author"`
	ElementHTML  string                    `json:"element_html,omitempty"`
	BoundingBox  *models.BoundingBox       `json:"bounding_box,omitempty"`
	SelectorData *models.SelectorFallback  `json:"selector_data,omitempty"`
}

type UpdateAnnotationRequest struct {
	Text     *string `json:"text,omitempty"`
	Resolved *bool   `json:"resolved,omitempty"`
}