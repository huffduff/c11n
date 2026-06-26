package utils

import (
	"net/url"
	"sort"
	"strings"
)

// NormalizeURL normalizes a URL for consistent storage and lookup
// Removes session parameters, sorts query params, and removes fragments
func NormalizeURL(rawURL string) (string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	
	// Remove hash fragments
	parsed.Fragment = ""
	
	// Remove session/tracking parameters
	paramsToRemove := []string{
		"utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
		"sessionId", "session_id", "PHPSESSID", "jsessionid",
		"_ga", "_gid", "_fbp", "_fbc",
	}
	
	for _, param := range paramsToRemove {
		parsed.Query().Del(param)
	}
	
	// Sort remaining query parameters for consistency
	sortedParams := make([]string, 0, len(parsed.Query()))
	for key, values := range parsed.Query() {
		for _, value := range values {
			sortedParams = append(sortedParams, key+"="+value)
		}
	}
	sort.Strings(sortedParams)
	
	if len(sortedParams) > 0 {
		parsed.RawQuery = strings.Join(sortedParams, "&")
	} else {
		parsed.RawQuery = ""
	}
	
	return parsed.String(), nil
}

// GenerateUserColor generates a consistent color for a user based on their ID
func GenerateUserColor(userID string) string {
	colors := []string{
		"#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FFEAA7",
		"#DDA0DD", "#98D8C8", "#F7DC6F", "#BB8FCE", "#85C1E9",
		"#F8C471", "#82E0AA", "#F1948A", "#85C1E9", "#D7BDE2",
	}
	
	// Simple hash to pick a color
	hash := 0
	for _, char := range userID {
		hash = int(char) + ((hash << 5) - hash)
	}
	
	if hash < 0 {
		hash = -hash
	}
	
	return colors[hash%len(colors)]
}