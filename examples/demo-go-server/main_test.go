package main

import (
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
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
	req := httptest.NewRequest(http.MethodGet, target, nil)
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

func TestAsset404(t *testing.T) {
	rec := get(t, newHandler(fixture()), "/assets/missing-abc.js", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing asset: status %d, want 404 (index.html fallback must not answer assets)", rec.Code)
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
