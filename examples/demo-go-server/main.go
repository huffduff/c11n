// Command demo-go-server serves the built demo-vue SPA the way the dogfood app
// does in production (ADR 0001): a Go backend serves the static bundle, an SPA
// fallback keeps deep links working, and a same-origin JSON API sits on /api.
// Stdlib only, so the e2e fixture adds no dependency to the repo.
package main

import (
	"compress/gzip"
	"encoding/json"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"strings"
	"time"
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	addr := flag.String("addr", envOr("C11N_GO_ADDR", "127.0.0.1:15174"), "listen address")
	dir := flag.String("dir", envOr("C11N_GO_DIST", "examples/demo-vue/dist"), "built SPA directory")
	flag.Parse()

	if _, err := os.Stat(path.Join(*dir, "index.html")); err != nil {
		log.Fatalf("demo-go-server: %s has no index.html (%v); run 'npm run build -w examples/demo-vue'", *dir, err)
	}

	log.Printf("demo-go-server: serving %s on http://%s", *dir, *addr)
	log.Fatal(newServer(*addr, *dir).ListenAndServe())
}

// newServer wires the handler and the timeouts. ReadHeaderTimeout bounds a
// client that connects and then dribbles headers (slowloris); IdleTimeout
// reaps keep-alive connections nothing is using.
func newServer(addr, dir string) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           withGzip(newHandler(os.DirFS(dir))),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
}

func newHandler(files fs.FS) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "server": "go"})
	})
	// /__echo is a TEST-ONLY fixture route, not part of the demo app: it exists
	// so e2e/specs/upstream-cookie.spec.ts can see exactly which request
	// headers the upstream received, and can make the upstream try to plant a
	// cookie. `?setcookie=1` emits two Set-Cookie headers, so the spec also
	// proves Caddy's header_down replacement acts on each value of a
	// multi-valued Set-Cookie response.
	mux.HandleFunc("/__echo", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		// The body describes one request; a cached copy would lie.
		w.Header().Set("Cache-Control", "no-store")
		if r.URL.Query().Get("setcookie") == "1" {
			w.Header().Add("Set-Cookie", "c11n_session=planted; Path=/; HttpOnly")
			w.Header().Add("Set-Cookie", "app_cookie=1; Path=/")
		}
		headers := make(map[string][]string, len(r.Header))
		for k, v := range r.Header {
			headers[k] = v
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"method":  r.Method,
			"path":    r.URL.Path,
			"query":   r.URL.RawQuery,
			"headers": headers,
		})
	})
	// Unknown /api paths are API misses, not client-side routes: answering
	// them with index.html made a typo'd fetch parse HTML as JSON.
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": "not found"})
	})
	mux.Handle("/", &spa{Files: files, Fileserver: http.FileServerFS(files)})
	return mux
}

// spa serves files from the bundle and falls back to index.html for unknown
// non-asset paths, so /pricing works on a hard reload. Routes containing a dot
// are treated as assets and must 404 instead of returning HTML: a missing .js
// answered with index.html breaks the module loader in confusing ways.
type spa struct {
	Files      fs.FS
	Fileserver http.Handler
}

func (s *spa) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	if info, err := fs.Stat(s.Files, name); err == nil {
		// A directory is not a file: FileServer would answer with a listing
		// (and redirect /assets to /assets/), which no client expects.
		if info.IsDir() {
			http.NotFound(w, r)
			return
		}
		s.Fileserver.ServeHTTP(w, r)
		return
	}
	if path.Ext(name) != "" {
		http.NotFound(w, r)
		return
	}
	clone := r.Clone(r.Context())
	// "/" (not "/index.html") on purpose: FileServer redirects an explicit
	// /index.html request to "./", which would turn a deep link into a 301.
	clone.URL.Path = "/"
	s.Fileserver.ServeHTTP(w, clone)
}

// withGzip compresses every response when the client accepts gzip. The point of
// the fixture: if Caddy's `header_up Accept-Encoding identity` ever stopped
// working, the HTML would arrive compressed and the `</head>` injection would
// silently do nothing.
func withGzip(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Set on every response, identity ones included: the body depends on
		// Accept-Encoding either way, so a shared cache must key on it too.
		w.Header().Add("Vary", "Accept-Encoding")
		// Range applies to the identity bytes. Compressing the slice would
		// leave Content-Range describing a length the body does not have, so
		// byte ranges are always served uncompressed.
		if r.Header.Get("Range") != "" {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method == http.MethodHead || !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Content-Encoding", "gzip")
		gz := gzip.NewWriter(w)
		defer gz.Close()
		next.ServeHTTP(&gzipWriter{ResponseWriter: w, gz: gz}, r)
	})
}

type gzipWriter struct {
	http.ResponseWriter
	gz *gzip.Writer
}

func (g *gzipWriter) WriteHeader(code int) {
	// Content-Length describes the uncompressed body; let Caddy/Go compute the
	// compressed length by closing the stream.
	g.Header().Del("Content-Length")
	g.ResponseWriter.WriteHeader(code)
}

func (g *gzipWriter) Write(b []byte) (int, error) { return g.gz.Write(b) }
