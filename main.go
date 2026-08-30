package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"strconv"
	"strings"
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
	return newHandlerWithStore(newMemoryFileStore())
}

func newHandlerWithStore(store hostedFileStore) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(healthResponse{
			Status:  "ok",
			Service: "tsyaiko-editor",
			Time:    time.Now().UTC().Format(time.RFC3339),
		})
	})
	mux.HandleFunc("GET /v1/files", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"files": store.List()})
	})
	mux.HandleFunc("POST /v1/files", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Name     string          `json:"name"`
			Document json.RawMessage `json:"document"`
		}
		if err := decodeLimitedJSON(r.Body, &request); err != nil {
			writeAPIError(w, http.StatusBadRequest, "invalid_request", "Expected a valid file snapshot request.")
			return
		}
		if !validDocument(request.Document) {
			writeAPIError(w, http.StatusUnprocessableEntity, "invalid_document", "Document must contain a positive version and pages array.")
			return
		}
		file, err := store.Create(request.Name, request.Document)
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "storage_error", "The file snapshot could not be stored.")
			return
		}
		writeHostedFile(w, http.StatusCreated, file)
	})
	mux.HandleFunc("GET /v1/files/{fileId}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("fileId")
		if !validHostedFileID(id) {
			writeAPIError(w, http.StatusNotFound, "file_not_found", "File not found.")
			return
		}
		file, err := store.Get(id)
		if err != nil {
			writeAPIError(w, http.StatusNotFound, "file_not_found", "File not found.")
			return
		}
		writeHostedFile(w, http.StatusOK, file)
	})
	mux.HandleFunc("PATCH /v1/files/{fileId}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("fileId")
		if !validHostedFileID(id) {
			writeAPIError(w, http.StatusNotFound, "file_not_found", "File not found.")
			return
		}
		expectedRevision, ok := parseRevisionETag(r.Header.Get("If-Match"))
		if !ok {
			writeAPIError(w, http.StatusPreconditionRequired, "revision_required", "Provide the current revision in If-Match.")
			return
		}
		var request struct {
			Name     *string         `json:"name"`
			Document json.RawMessage `json:"document"`
		}
		if err := decodeLimitedJSON(r.Body, &request); err != nil || (request.Name == nil && request.Document == nil) {
			writeAPIError(w, http.StatusBadRequest, "invalid_request", "Provide a name or document update.")
			return
		}
		if request.Document != nil && !validDocument(request.Document) {
			writeAPIError(w, http.StatusUnprocessableEntity, "invalid_document", "Document must contain a positive version and pages array.")
			return
		}
		file, err := store.Update(id, expectedRevision, request.Name, request.Document)
		if err == errFileNotFound {
			writeAPIError(w, http.StatusNotFound, "file_not_found", "File not found.")
			return
		}
		if err == errRevisionConflict {
			w.Header().Set("ETag", revisionETag(file.Revision))
			writeJSON(w, http.StatusConflict, map[string]any{
				"error":           map[string]any{"code": "revision_conflict", "message": "The file has a newer revision."},
				"currentRevision": file.Revision,
			})
			return
		}
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "storage_error", "The file snapshot could not be stored.")
			return
		}
		writeHostedFile(w, http.StatusOK, file)
	})

	staticFiles, err := fs.Sub(webFiles, "web")
	if err != nil {
		panic(err)
	}
	mux.Handle("/", http.FileServer(http.FS(staticFiles)))

	return withSecurityHeaders(mux)
}

func revisionETag(revision int64) string {
	return fmt.Sprintf("\"%d\"", revision)
}

func parseRevisionETag(value string) (int64, bool) {
	value = strings.TrimSpace(value)
	if len(value) < 3 || value[0] != '"' || value[len(value)-1] != '"' {
		return 0, false
	}
	revision, err := strconv.ParseInt(value[1:len(value)-1], 10, 64)
	return revision, err == nil && revision > 0
}

func writeHostedFile(w http.ResponseWriter, status int, file hostedFile) {
	w.Header().Set("ETag", revisionETag(file.Revision))
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, status, file)
}

func writeAPIError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
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
	dataDirectory := flag.String("data-dir", "data", "hosted file snapshot directory")
	flag.Parse()
	store, err := newDiskFileStore(*dataDirectory)
	if err != nil {
		log.Fatal(err)
	}

	address := fmt.Sprintf(":%d", *port)
	server := &http.Server{
		Addr:              address,
		Handler:           newHandlerWithStore(store),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("Tsyaiko is ready at http://localhost:%d", *port)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
