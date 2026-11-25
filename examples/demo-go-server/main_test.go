package main

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

// fixture mirrors the built demo-vue bundle closely enough for the routing
// rules: a root index.html and one hashed asset under /assets.
func fixture() fstest.MapFS {
	return fstest.MapFS{
		"index.html":          &fstest.MapFile{Data: []byte("<html><head></head><body>spa</body></html>")},
		"assets/index-abc.js": &fstest.MapFile{Data: []byte("console.log('app')")},
	}
}

func get(t *testing.T, h http.Handler, target string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	return do(t, h, http.MethodGet, target, headers)
}

func do(t *testing.T, h http.Handler, method, target string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestSPAFallback(t *testing.T) {
	rec := get(t, newHandler(fixture()), "/pricing", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("deep link /pricing: status %d, want 200", rec.Code)
	}
	if body := rec.Body.String(); body != "<html><head></head><body>spa</body></html>" {
		t.Fatalf("deep link served %q, want index.html", body)
	}
}

func TestSPAFallbackTrailingSlash(t *testing.T) {
	rec := get(t, newHandler(fixture()), "/pricing/", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("/pricing/: status %d, want 200 (SPA fallback)", rec.Code)
	}
	if body := rec.Body.String(); body != "<html><head></head><body>spa</body></html>" {
		t.Fatalf("/pricing/ served %q, want index.html", body)
	}
}

func TestAsset404(t *testing.T) {
	rec := get(t, newHandler(fixture()), "/assets/missing-abc.js", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing asset: status %d, want 404 (index.html fallback must not answer assets)", rec.Code)
	}
}

func TestAssetsDirectory404(t *testing.T) {
	h := newHandler(fixture())
	for _, target := range []string{"/assets/", "/assets"} {
		rec := get(t, h, target, nil)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s: status %d, want 404 (a directory listing is not a file)", target, rec.Code)
		}
		if strings.Contains(rec.Body.String(), "index-abc.js") {
			t.Fatalf("%s: response is a directory listing: %q", target, rec.Body.String())
		}
	}
}

func TestEncodedTraversalStaysInsideDist(t *testing.T) {
	rec := get(t, newHandler(fixture()), "/%2e%2e/etc/passwd", nil)
	body := rec.Body.String()
	if strings.Contains(body, "root:") {
		t.Fatalf("encoded traversal served a host file: %q", body)
	}
	// Containment means the cleaned path names no bundle file, so it is either
	// a 404 or the SPA fallback — never something outside dist.
	if rec.Code != http.StatusNotFound && rec.Code != http.StatusOK {
		t.Fatalf("encoded traversal: status %d", rec.Code)
	}
	if rec.Code == http.StatusOK && body != "<html><head></head><body>spa</body></html>" {
		t.Fatalf("encoded traversal served %q, want index.html or 404", body)
	}
}

func TestExistingAsset(t *testing.T) {
	rec := get(t, newHandler(fixture()), "/assets/index-abc.js", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("existing asset: status %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct == "" ||
		(ct != "text/javascript; charset=utf-8" && ct != "application/javascript") {
		t.Fatalf("existing asset: Content-Type %q is not javascript", ct)
	}
}

func TestAPIPing(t *testing.T) {
	rec := get(t, newHandler(fixture()), "/api/ping", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("/api/ping: status %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("/api/ping: Content-Type %q, want application/json", ct)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("/api/ping: invalid JSON: %v", err)
	}
	if body["ok"] != true || body["server"] != "go" {
		t.Fatalf("/api/ping: body %v, want ok=true server=go", body)
	}
}

func TestUnknownAPIIsJSON404(t *testing.T) {
	rec := get(t, newHandler(fixture()), "/api/unknown", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("/api/unknown: status %d, want 404", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("/api/unknown: Content-Type %q, want application/json", ct)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("/api/unknown: invalid JSON: %v", err)
	}
	if body["error"] != "not found" {
		t.Fatalf("/api/unknown: body %v, want {\"error\":\"not found\"}", body)
	}
}

func TestMethodNotAllowedAllowHeader(t *testing.T) {
	rec := do(t, newHandler(fixture()), http.MethodPost, "/api/ping", nil)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /api/ping: status %d, want 405", rec.Code)
	}
	if allow := rec.Header().Get("Allow"); allow != "GET, HEAD" {
		t.Fatalf("POST /api/ping: Allow %q, want %q", allow, "GET, HEAD")
	}
}

func TestHead(t *testing.T) {
	rec := do(t, newHandler(fixture()), http.MethodHead, "/", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("HEAD /: status %d, want 200", rec.Code)
	}
	if enc := rec.Header().Get("Content-Encoding"); enc != "" {
		t.Fatalf("HEAD /: Content-Encoding %q, want none", enc)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("HEAD /: body %q, want empty", rec.Body.String())
	}
}

func TestGzipNegotiation(t *testing.T) {
	h := withGzip(newHandler(fixture()))

	rec := get(t, h, "/", map[string]string{"Accept-Encoding": "gzip, deflate"})
	if enc := rec.Header().Get("Content-Encoding"); enc != "gzip" {
		t.Fatalf("Accept-Encoding gzip: Content-Encoding %q, want gzip", enc)
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("Accept-Encoding gzip: body is not gzip: %v", err)
	}
	defer zr.Close()
	plain, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("Accept-Encoding gzip: cannot decompress: %v", err)
	}
	if string(plain) != "<html><head></head><body>spa</body></html>" {
		t.Fatalf("Accept-Encoding gzip: decompressed %q", plain)
	}

	// No gzip advertised (what Caddy sends after header_up Accept-Encoding
	// identity): plaintext, so the proxy's </head> replace can work.
	plainRec := get(t, h, "/", map[string]string{"Accept-Encoding": "identity"})
	if enc := plainRec.Header().Get("Content-Encoding"); enc != "" {
		t.Fatalf("Accept-Encoding identity: Content-Encoding %q, want none", enc)
	}
	if body := plainRec.Body.String(); body != "<html><head></head><body>spa</body></html>" {
		t.Fatalf("Accept-Encoding identity: body %q is not the plain index.html", body)
	}
}

// TestVaryOnBothPaths: the body depends on Accept-Encoding whichever branch
// runs, so Vary must be on the compressed AND the identity response. Without
// it a shared cache can replay a gzipped body to a client that cannot decode
// it (or vice versa).
func TestVaryOnBothPaths(t *testing.T) {
	h := withGzip(newHandler(fixture()))
	for _, enc := range []string{"gzip", "identity"} {
		rec := get(t, h, "/assets/index-abc.js", map[string]string{"Accept-Encoding": enc})
		if vary := strings.Join(rec.Header().Values("Vary"), ","); !strings.Contains(vary, "Accept-Encoding") {
			t.Fatalf("Accept-Encoding %s: Vary %q lacks Accept-Encoding", enc, vary)
		}
	}
}

// TestRangeBypassesGzip: a 206 describes the identity bytes. Compressing the
// slice leaves Content-Range lying about the body, so Range requests are served
// uncompressed.
func TestRangeBypassesGzip(t *testing.T) {
	const content = "console.log('app')"
	h := withGzip(newHandler(fixture()))
	rec := get(t, h, "/assets/index-abc.js", map[string]string{
		"Accept-Encoding": "gzip",
		"Range":           "bytes=0-6",
	})
	if rec.Code != http.StatusPartialContent {
		t.Fatalf("Range request: status %d, want 206", rec.Code)
	}
	if enc := rec.Header().Get("Content-Encoding"); enc != "" {
		t.Fatalf("Range request: Content-Encoding %q, want none", enc)
	}
	if cr, want := rec.Header().Get("Content-Range"), fmt.Sprintf("bytes 0-6/%d", len(content)); cr != want {
		t.Fatalf("Range request: Content-Range %q, want %q", cr, want)
	}
	if body := rec.Body.String(); body != content[:7] {
		t.Fatalf("Range request: body %q, want %q", body, content[:7])
	}
	if vary := strings.Join(rec.Header().Values("Vary"), ","); !strings.Contains(vary, "Accept-Encoding") {
		t.Fatalf("Range request: Vary %q lacks Accept-Encoding", vary)
	}
}
