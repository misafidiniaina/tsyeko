package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"time"
)

//go:embed web
var webFiles embed.FS

type healthResponse struct {
	Status  string `json:"status"`
	Service string `json:"service"`
	Time    string `json:"time"`
}

func newHandler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(healthResponse{
			Status:  "ok",
			Service: "tsyaiko-editor",
			Time:    time.Now().UTC().Format(time.RFC3339),
		})
	})

	staticFiles, err := fs.Sub(webFiles, "web")
	if err != nil {
		panic(err)
	}
	mux.Handle("/", http.FileServer(http.FS(staticFiles)))

	return withSecurityHeaders(mux)
}

func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		next.ServeHTTP(w, r)
	})
}

func main() {
	port := flag.Int("port", 8080, "HTTP port")
	flag.Parse()

	address := fmt.Sprintf(":%d", *port)
	server := &http.Server{
		Addr:              address,
		Handler:           newHandler(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("Tsyaiko is ready at http://localhost:%d", *port)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
