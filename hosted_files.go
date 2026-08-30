package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxHostedDocumentBytes = 10 << 20

var (
	errFileNotFound     = errors.New("file not found")
	errRevisionConflict = errors.New("revision conflict")
)

type hostedFile struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Revision  int64           `json:"revision"`
	Document  json.RawMessage `json:"document"`
	CreatedAt time.Time       `json:"createdAt"`
	UpdatedAt time.Time       `json:"updatedAt"`
}

type hostedFileSummary struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Revision  int64     `json:"revision"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type hostedFileStore interface {
	Create(name string, document json.RawMessage) (hostedFile, error)
	Get(id string) (hostedFile, error)
	List() []hostedFileSummary
	Update(id string, expectedRevision int64, name *string, document json.RawMessage) (hostedFile, error)
}

type memoryFileStore struct {
	mu    sync.RWMutex
	files map[string]hostedFile
	write func(hostedFile) error
}

func newMemoryFileStore() *memoryFileStore {
	return &memoryFileStore{files: make(map[string]hostedFile)}
}

func newDiskFileStore(directory string) (*memoryFileStore, error) {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	store := newMemoryFileStore()
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, fmt.Errorf("read data directory: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		data, readErr := os.ReadFile(filepath.Join(directory, entry.Name()))
		if readErr != nil {
			return nil, fmt.Errorf("read snapshot %s: %w", entry.Name(), readErr)
		}
		var file hostedFile
		if decodeErr := json.Unmarshal(data, &file); decodeErr != nil {
			return nil, fmt.Errorf("decode snapshot %s: %w", entry.Name(), decodeErr)
		}
		if !validHostedFileID(file.ID) || file.Revision < 1 || !validDocument(file.Document) {
			return nil, fmt.Errorf("invalid snapshot %s", entry.Name())
		}
		store.files[file.ID] = cloneHostedFile(file)
	}
	store.write = func(file hostedFile) error {
		data, err := json.Marshal(file)
		if err != nil {
			return err
		}
		temporary, err := os.CreateTemp(directory, ".snapshot-*")
		if err != nil {
			return err
		}
		temporaryName := temporary.Name()
		defer os.Remove(temporaryName)
		if err = temporary.Chmod(0o600); err == nil {
			_, err = temporary.Write(data)
		}
		if err == nil {
			err = temporary.Sync()
		}
		if closeErr := temporary.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			return err
		}
		return os.Rename(temporaryName, filepath.Join(directory, file.ID+".json"))
	}
	return store, nil
}

func (store *memoryFileStore) Create(name string, document json.RawMessage) (hostedFile, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	now := time.Now().UTC()
	file := hostedFile{
		ID: newHostedFileID(), Name: cleanHostedName(name), Revision: 1,
		Document: append(json.RawMessage(nil), document...), CreatedAt: now, UpdatedAt: now,
	}
	if store.write != nil {
		if err := store.write(file); err != nil {
			return hostedFile{}, err
		}
	}
	store.files[file.ID] = file
	return cloneHostedFile(file), nil
}

func (store *memoryFileStore) Get(id string) (hostedFile, error) {
	store.mu.RLock()
	defer store.mu.RUnlock()
	file, ok := store.files[id]
	if !ok {
		return hostedFile{}, errFileNotFound
	}
	return cloneHostedFile(file), nil
}

func (store *memoryFileStore) List() []hostedFileSummary {
	store.mu.RLock()
	defer store.mu.RUnlock()
	files := make([]hostedFileSummary, 0, len(store.files))
	for _, file := range store.files {
		files = append(files, hostedFileSummary{
			ID: file.ID, Name: file.Name, Revision: file.Revision,
			CreatedAt: file.CreatedAt, UpdatedAt: file.UpdatedAt,
		})
	}
	sort.Slice(files, func(i, j int) bool {
		if files[i].UpdatedAt.Equal(files[j].UpdatedAt) {
			return files[i].ID < files[j].ID
		}
		return files[i].UpdatedAt.After(files[j].UpdatedAt)
	})
	return files
}

func (store *memoryFileStore) Update(id string, expectedRevision int64, name *string, document json.RawMessage) (hostedFile, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	current, ok := store.files[id]
	if !ok {
		return hostedFile{}, errFileNotFound
	}
	if current.Revision != expectedRevision {
		return cloneHostedFile(current), errRevisionConflict
	}
	next := cloneHostedFile(current)
	if name != nil {
		next.Name = cleanHostedName(*name)
	}
	if document != nil {
		next.Document = append(json.RawMessage(nil), document...)
	}
	next.Revision++
	next.UpdatedAt = time.Now().UTC()
	if store.write != nil {
		if err := store.write(next); err != nil {
			return hostedFile{}, err
		}
	}
	store.files[id] = next
	return cloneHostedFile(next), nil
}

func newHostedFileID() string {
	bytes := make([]byte, 12)
	if _, err := rand.Read(bytes); err != nil {
		panic("secure random source unavailable: " + err.Error())
	}
	return "file_" + hex.EncodeToString(bytes)
}

func validHostedFileID(id string) bool {
	if !strings.HasPrefix(id, "file_") || len(id) != 29 {
		return false
	}
	_, err := hex.DecodeString(strings.TrimPrefix(id, "file_"))
	return err == nil
}

func cleanHostedName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "Untitled file"
	}
	runes := []rune(name)
	if len(runes) > 120 {
		runes = runes[:120]
	}
	return string(runes)
}

func validDocument(document json.RawMessage) bool {
	if len(document) == 0 || len(document) > maxHostedDocumentBytes || !json.Valid(document) {
		return false
	}
	var envelope struct {
		Version json.Number       `json:"version"`
		Pages   []json.RawMessage `json:"pages"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(document)))
	decoder.UseNumber()
	if err := decoder.Decode(&envelope); err != nil || envelope.Version == "" || envelope.Pages == nil {
		return false
	}
	version, err := strconv.Atoi(envelope.Version.String())
	return err == nil && version > 0
}

func cloneHostedFile(file hostedFile) hostedFile {
	file.Document = append(json.RawMessage(nil), file.Document...)
	return file
}

func decodeLimitedJSON(reader io.Reader, target any) error {
	decoder := json.NewDecoder(io.LimitReader(reader, maxHostedDocumentBytes+4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("request must contain one JSON object")
	}
	return nil
}
