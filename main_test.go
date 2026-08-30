package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealthEndpoint(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	recorder := httptest.NewRecorder()

	newHandler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", recorder.Code)
	}

	var response healthResponse
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.Status != "ok" {
		t.Fatalf("expected healthy response, got %q", response.Status)
	}
}

func TestIndexIsServed(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	recorder := httptest.NewRecorder()

	newHandler().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", recorder.Code)
	}
	if contentType := recorder.Header().Get("Content-Type"); contentType != "text/html; charset=utf-8" {
		t.Fatalf("expected HTML, got %q", contentType)
	}
}

func TestHostedFileLifecycleAndRevisionConflict(t *testing.T) {
	handler := newHandlerWithStore(newMemoryFileStore())
	document := json.RawMessage(`{"version":10,"pages":[]}`)
	createBody, _ := json.Marshal(map[string]any{"name": "Design system", "document": document})
	createRequest := httptest.NewRequest(http.MethodPost, "/v1/files", bytes.NewReader(createBody))
	createRecorder := httptest.NewRecorder()
	handler.ServeHTTP(createRecorder, createRequest)
	if createRecorder.Code != http.StatusCreated {
		t.Fatalf("expected create status 201, got %d: %s", createRecorder.Code, createRecorder.Body.String())
	}
	var created hostedFile
	if err := json.NewDecoder(createRecorder.Body).Decode(&created); err != nil {
		t.Fatalf("decode created file: %v", err)
	}
	if created.Revision != 1 || created.Name != "Design system" || !validHostedFileID(created.ID) {
		t.Fatalf("unexpected created file: %#v", created)
	}
	if createRecorder.Header().Get("ETag") != `"1"` {
		t.Fatalf("expected revision ETag, got %q", createRecorder.Header().Get("ETag"))
	}

	updateBody := strings.NewReader(`{"name":"Updated design system"}`)
	updateRequest := httptest.NewRequest(http.MethodPatch, "/v1/files/"+created.ID, updateBody)
	updateRequest.Header.Set("If-Match", `"1"`)
	updateRecorder := httptest.NewRecorder()
	handler.ServeHTTP(updateRecorder, updateRequest)
	if updateRecorder.Code != http.StatusOK {
		t.Fatalf("expected update status 200, got %d: %s", updateRecorder.Code, updateRecorder.Body.String())
	}
	var updated hostedFile
	if err := json.NewDecoder(updateRecorder.Body).Decode(&updated); err != nil {
		t.Fatalf("decode updated file: %v", err)
	}
	if updated.Revision != 2 || updated.Name != "Updated design system" {
		t.Fatalf("unexpected updated file: %#v", updated)
	}

	conflictRequest := httptest.NewRequest(http.MethodPatch, "/v1/files/"+created.ID, strings.NewReader(`{"name":"Stale edit"}`))
	conflictRequest.Header.Set("If-Match", `"1"`)
	conflictRecorder := httptest.NewRecorder()
	handler.ServeHTTP(conflictRecorder, conflictRequest)
	if conflictRecorder.Code != http.StatusConflict {
		t.Fatalf("expected conflict status 409, got %d", conflictRecorder.Code)
	}
	if conflictRecorder.Header().Get("ETag") != `"2"` {
		t.Fatalf("expected current revision ETag, got %q", conflictRecorder.Header().Get("ETag"))
	}

	getRequest := httptest.NewRequest(http.MethodGet, "/v1/files/"+created.ID, nil)
	getRecorder := httptest.NewRecorder()
	handler.ServeHTTP(getRecorder, getRequest)
	if getRecorder.Code != http.StatusOK {
		t.Fatalf("expected get status 200, got %d", getRecorder.Code)
	}
	var fetched hostedFile
	if err := json.NewDecoder(getRecorder.Body).Decode(&fetched); err != nil {
		t.Fatalf("decode fetched file: %v", err)
	}
	if fetched.Name != updated.Name || fetched.Revision != 2 {
		t.Fatalf("stale update changed stored file: %#v", fetched)
	}
}

func TestHostedFileValidationAndPreconditions(t *testing.T) {
	handler := newHandlerWithStore(newMemoryFileStore())
	invalidRequest := httptest.NewRequest(http.MethodPost, "/v1/files", strings.NewReader(`{"document":{"version":10}}`))
	invalidRecorder := httptest.NewRecorder()
	handler.ServeHTTP(invalidRecorder, invalidRequest)
	if invalidRecorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected invalid document status 422, got %d", invalidRecorder.Code)
	}

	createRequest := httptest.NewRequest(http.MethodPost, "/v1/files", strings.NewReader(`{"document":{"version":10,"pages":[]}}`))
	createRecorder := httptest.NewRecorder()
	handler.ServeHTTP(createRecorder, createRequest)
	var created hostedFile
	_ = json.NewDecoder(createRecorder.Body).Decode(&created)

	updateRequest := httptest.NewRequest(http.MethodPatch, "/v1/files/"+created.ID, strings.NewReader(`{"name":"No revision"}`))
	updateRecorder := httptest.NewRecorder()
	handler.ServeHTTP(updateRecorder, updateRequest)
	if updateRecorder.Code != http.StatusPreconditionRequired {
		t.Fatalf("expected precondition status 428, got %d", updateRecorder.Code)
	}
}

func TestDiskFileStoreReloadsDurableSnapshots(t *testing.T) {
	directory := t.TempDir()
	store, err := newDiskFileStore(directory)
	if err != nil {
		t.Fatalf("create disk store: %v", err)
	}
	created, err := store.Create("Durable", json.RawMessage(`{"version":10,"pages":[]}`))
	if err != nil {
		t.Fatalf("store snapshot: %v", err)
	}
	updatedName := "Durable v2"
	if _, err = store.Update(created.ID, 1, &updatedName, nil); err != nil {
		t.Fatalf("update snapshot: %v", err)
	}

	reloaded, err := newDiskFileStore(directory)
	if err != nil {
		t.Fatalf("reload disk store: %v", err)
	}
	file, err := reloaded.Get(created.ID)
	if err != nil {
		t.Fatalf("get reloaded snapshot: %v", err)
	}
	if file.Name != updatedName || file.Revision != 2 {
		t.Fatalf("unexpected reloaded file: %#v", file)
	}
}
