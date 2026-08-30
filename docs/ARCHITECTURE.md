# Tsyaiko architecture and delivery plan

## 1. Product intent

Tsyaiko should become a collaborative, browser-first interface design platform. The product is organized around four systems:

1. A durable design document model
2. A high-performance graphics and text engine
3. A real-time collaboration protocol
4. A multi-tenant SaaS platform

The current repository implements the first usable vertical slice of systems 1 and 2, with local persistence and a thin application server.

## 2. Product surfaces

The complete product is expected to include:

- Design editor: vector objects, text, images, frames, constraints, and auto layout
- Design systems: components, variants, styles, variables, modes, and libraries
- Prototyping: events, navigation, overlays, transitions, and presentation
- Collaboration: multiplayer editing, cursors, comments, mentions, and history
- Developer mode: measurements, assets, variables, and code-oriented inspection
- Platform: organizations, projects, permissions, billing, APIs, and plugins
- Enterprise: SSO, SCIM, audit trails, retention controls, and regional storage

## 3. Current runtime architecture

```text
Browser
├── HTML/CSS application shell
├── Editor controller
│   ├── tools and pointer interactions
│   ├── inspector and layers panel
│   └── IndexedDB autosave with localStorage migration/fallback
├── Versioned hierarchical document model
├── Snapshot history
├── Canvas 2D renderer
└── SVG/PNG/JSON exporters
          │
          ▼
Embedded Go HTTP server
├── static assets
├── GET /api/health
└── security response headers
```

The Go binary embeds `web/`, producing a single deployable artifact with no runtime package installation.

## 4. Target production architecture

```text
Web / desktop clients
        │
        ▼
Edge CDN + API gateway
        │
 ┌──────┼───────────┬─────────────┬──────────────┐
 │      │           │             │              │
Auth  File API  Collaboration  Asset API      Export API
 │      │           │             │              │
 │   PostgreSQL  WebSockets     Object store   Job queue
 │      │           │             │              │
 │   snapshots   Redis/NATS       CDN         render workers
 │      │           │                            │
 └──────┴───────────┴────────────────────────────┘
                         │
                  telemetry pipeline
```

Recommended initial production choices:

- Web client: TypeScript and React for panels, WebGL/WebGPU for the scene
- Shared engine: Rust compiled to WebAssembly for geometry, paths, and layout where profiling justifies it
- Product APIs: Go
- Primary database: PostgreSQL
- Ephemeral presence and room routing: Redis
- Durable event transport: NATS JetStream or Kafka only when scale requires it
- Assets and snapshots: S3-compatible object storage plus CDN
- Background workflows: Temporal or a managed queue
- Observability: OpenTelemetry, Prometheus-compatible metrics, structured logs, and traces

Avoid introducing every distributed component on day one. PostgreSQL, Redis, object storage, and stateless Go services are enough for the first hosted release.

## 5. Document model

The current v4 file format is a versioned, multi-page JSON document with flat storage, explicit parent relationships, paint definitions, and effects. Version 1 root-node files, version 2 multi-page files, and version 3 hierarchical files migrate automatically. Imports repair dangling parents, reject non-container parents, break cycles, sanitize paint/effect values, and restore parent-before-child ordering:

```json
{
  "version": 4,
  "id": "document_…",
  "name": "Untitled design",
  "background": "#101114",
  "pages": [
    {
      "id": "page_…",
      "name": "Landing page",
      "background": "#101114",
      "nodes": [
        {
          "id": "frame_…",
          "type": "frame",
          "name": "Desktop",
          "parentId": null,
          "x": 0,
          "y": 0,
          "width": 1440,
          "height": 900,
          "rotation": 0,
          "opacity": 1,
          "visible": true,
          "locked": false,
          "fill": "#ffffff",
          "stroke": "#d8d8de",
          "strokeWidth": 1,
          "cornerRadius": 0
        },
        {
          "id": "rectangle_…",
          "type": "rectangle",
          "name": "Card",
          "parentId": "frame_…",
          "x": 100,
          "y": 80,
          "width": 320,
          "height": 180,
          "rotation": 0,
          "opacity": 1,
          "visible": true,
          "locked": false,
          "fill": "#ffffff",
          "fillType": "linear-gradient",
          "gradient": {
            "angle": 30,
            "stops": [
              { "position": 0, "color": "#7c3aed" },
              { "position": 1, "color": "#ec4899" }
            ]
          },
          "stroke": "#d8d8de",
          "strokeWidth": 1,
          "cornerRadius": 16,
          "shadow": {
            "enabled": true,
            "color": "#000000",
            "opacity": 0.24,
            "offsetX": 0,
            "offsetY": 8,
            "blur": 24
          }
        }
      ]
    }
  ]
}
```

Production evolution:

- Move from world-space child geometry to consistently decomposed local transforms or matrices
- Add explicit sibling ordering when collaboration requires ordering independent of array position
- Add vector paths, boolean operations, masks, multiple paint stacks, radial/angular gradients, and blur effects
- Add rich-text ranges and font references
- Add component definitions, instances, override maps, and variant properties
- Add constraints and auto-layout properties
- Add prototype edges separately from visual nodes
- Add explicit schema migrations for every document version

Stable node IDs are non-negotiable. History, comments, component overrides, prototypes, and collaboration all refer to them.

## 6. Editor state boundaries

Keep these states separate:

| State | Examples | Persistence |
|---|---|---|
| Document | nodes, styles, component data | Durable and collaborative |
| View | camera, active page, panel sizes | Per-user preference |
| Selection | selected IDs, hover, active handle | Ephemeral per user |
| Presence | cursor, selection broadcast, online state | Ephemeral network state |
| Interaction | drag start, preview node, snap guides | Local and transient |

Mixing selection or camera data into the shared document creates unnecessary collaboration conflicts.

## 7. Rendering engine

Canvas 2D is appropriate for the MVP. The migration trigger for WebGL/WebGPU should be measured, not assumed. Move when realistic documents miss the performance budgets below.

Target renderer pipeline:

```text
Document changes
    ↓
Scene graph update
    ↓
Spatial index + visibility culling
    ↓
Paint batching and glyph/image atlas lookup
    ↓
GPU command submission
    ↓
Selection and collaboration overlays
```

Required capabilities:

- Camera matrices and high-DPI output
- R-tree or bounding-volume spatial index
- Incremental scene updates and dirty flags
- View-frustum culling
- Batched fills, strokes, and textured quads
- Tessellated vector paths
- Clipping and nested masks
- Cached effects and shadows
- Glyph shaping and font atlas management
- GPU context-loss recovery
- Deterministic export path

Initial performance budgets:

- 60 frames per second during ordinary pan, zoom, and drag
- Less than 16 ms p95 interaction frame time on a representative laptop
- Less than 100 ms to open a 5,000-node cached document
- Less than 1 second to open a 50,000-node document after download
- Selection hit testing below 8 ms p95
- Memory below 500 MB for a representative large document

## 8. Text architecture

Text fidelity is one of the highest-risk areas. The browser, server exporter, and eventual desktop client must agree on:

- Font files and fallback order
- Glyph shaping and OpenType features
- Font metrics
- Line breaks and whitespace rules
- Letter spacing and line height
- Rich-text runs
- Baseline placement

Use a shared shaping engine such as HarfBuzz and a controlled font pipeline when exact fidelity becomes necessary. Fonts must be licensed for storage, editing, and server-side export.

## 9. Commands, history, and collaboration

The MVP keeps bounded full-document snapshots because that implementation is reliable and easy to inspect. Production editing should use semantic transactions:

```json
{
  "transactionId": "tx_…",
  "actorId": "user_…",
  "baseVersion": 418,
  "operations": [
    { "op": "set", "nodeId": "node_1", "path": ["x"], "value": 240 },
    { "op": "set", "nodeId": "node_1", "path": ["y"], "value": 96 }
  ]
}
```

One pointer drag should become one user-visible history transaction, even if intermediate states are streamed for responsiveness.

For collaboration, adopt an established CRDT implementation or a well-specified server-authoritative operation system. Do not invent conflict resolution casually. The protocol needs:

- Idempotent transaction IDs
- Per-actor ordering
- Reconnection and missed-operation recovery
- Snapshot and operation-log compaction
- Offline queues
- Permission checks at transaction acceptance
- Presence on a separate, lossy channel
- Schema-version negotiation

Persistent edits and presence must use separate message classes. Losing a cursor update is harmless; losing a node mutation is not.

## 10. Data persistence

Recommended hosted model:

```text
PostgreSQL
├── users, organizations, teams, projects
├── files and file memberships
├── current snapshot metadata
├── comments and mentions
├── library publications
├── subscriptions and entitlements
└── audit events

Object storage
├── compressed document snapshots
├── images and videos
├── font assets
├── generated thumbnails
└── export results

Operation store
└── ordered transactions since the latest compacted snapshot
```

On open, the client receives a recent snapshot and all accepted operations after that snapshot. Background compaction creates a new snapshot and safely expires old operations according to the history policy.

## 11. API boundaries

Ordinary product APIs can use JSON over HTTP:

```text
POST   /v1/files
GET    /v1/files/{fileId}
PATCH  /v1/files/{fileId}
POST   /v1/files/{fileId}/members
GET    /v1/files/{fileId}/versions
POST   /v1/files/{fileId}/exports
POST   /v1/assets/uploads
GET    /v1/libraries/{libraryId}
```

Use signed URLs for large uploads and downloads. The application API should not proxy multi-megabyte image bodies unnecessarily.

The real-time connection needs messages such as:

```text
join_file
snapshot
transaction
transaction_ack
presence_update
resync_required
permission_changed
```

Every mutation is authorized server-side. Client UI permissions are convenience, not security.

## 12. Auto layout and constraints

Implement layout as a deterministic pure function of document properties. Begin with:

- Horizontal and vertical stacks
- Padding and gap
- Primary and cross-axis alignment
- Fixed, hug-content, and fill-container sizing
- Min/max dimensions
- Absolute children

Layout invalidation should recompute only affected ancestors and descendants. The browser and export worker must use the same algorithm and font metrics.

## 13. Components and design systems

The minimum useful model includes:

- Component definition node
- Instance node referencing a component version
- Stable descendant identity across definition and instance
- Explicit override map
- Component properties and variants
- Published library versions
- Variables with types, collections, modes, aliases, and scopes

Library publication must be immutable. A file consumes a specific published version and deliberately upgrades to a newer one.

## 14. Export architecture

Small exports can remain client-side. Hosted exports should become queued jobs when they involve large documents, many variants, PDF generation, or controlled fonts.

```text
Client requests export
    ↓
API validates file access and options
    ↓
Queue receives immutable snapshot reference
    ↓
Renderer worker generates output
    ↓
Object storage + short-lived download URL
```

Export workers must be resource-limited because imported documents and fonts are untrusted input.

## 15. Security and privacy

Baseline controls:

- TLS everywhere and encryption at rest
- Tenant-scoped authorization on every request
- Short-lived signed asset URLs
- Content-type, size, and malware checks for uploads
- Rate limits by identity, organization, and IP
- Session rotation, MFA, and revocation
- Audit logs for administrative and sharing changes
- Strict plugin sandbox and capability permissions
- CSP and dependency integrity controls
- Secrets in a managed secret store
- Backups with tested restoration
- Data deletion and retention workflows

Enterprise additions include SAML/OIDC SSO, SCIM, domain capture, legal hold, configurable retention, and regional data residency.

Threat modeling should specifically cover malicious documents, decompression bombs, font parser vulnerabilities, oversized collaboration operations, cross-tenant asset references, and plugin data exfiltration.

## 16. Reliability and observability

Define service-level indicators before scaling:

- File-open success and latency
- Accepted collaboration transaction latency
- Reconnect success rate
- Autosave acknowledgment lag
- Export success and queue duration
- Renderer crashes and GPU context loss
- API availability and error rate

Every request and collaboration transaction should carry a trace ID. Logs must avoid raw document contents and user text by default.

Initial service objectives might be:

- 99.9% monthly API availability
- 99.95% successful accepted-operation delivery
- Collaboration p95 acknowledgment below 250 ms within a deployment region
- 99% of ordinary exports completed within 30 seconds

## 17. Testing strategy

Use multiple layers of testing:

- Unit tests for geometry, layout, commands, serialization, and migrations
- Property-based tests for transforms, path operations, and concurrent edits
- Visual regression tests with controlled fonts and GPUs
- Browser tests for pointer, keyboard, clipboard, and accessibility workflows
- Deterministic multi-client simulations for collaboration
- Fuzz tests for document import, SVG parsing, fonts, and protocol messages
- Load tests for file rooms and export queues
- Backup restoration and regional failover exercises

Every document schema change needs forward-migration tests and fixtures from old versions.

## 18. Delivery roadmap

### Milestone 0 — implemented foundation

- Canvas editor and basic nodes
- Multi-page documents, page operations, and v1/v2/v3 schema migration
- Hierarchical frames and groups with recursive editing and cycle-safe imports
- Nested layers, frame clipping, and inherited visibility, locking, and opacity
- Linear-gradient fills and explicit drop-shadow effects with Canvas/SVG parity
- Per-page canvas appearance and view state
- Embedded raster image layers with cover/contain fitting
- IndexedDB persistence and compact localStorage recovery copies
- Selection and transforms
- Layers and inspector
- History and local autosave
- PNG, SVG, and JSON export
- Embedded development server

### Milestone 1 — structured editor

- Multiple paint stacks, radial/angular gradients, blur effects, masks, and boolean geometry
- Vector pen and path editing
- Better text shaping and rich-text ranges
- Command-based history
- Dedicated content-addressed asset records and storage quotas

Exit criterion: a designer can complete and export a small production UI without leaving the editor.

### Milestone 2 — hosted collaboration

- Accounts, organizations, projects, and sharing
- PostgreSQL and object storage
- WebSocket rooms and presence
- Durable operations, reconnect, and compaction
- Comments, mentions, thumbnails, and version history

Exit criterion: a team can safely co-edit a file and recover from disconnects or browser restarts.

### Milestone 3 — professional design systems

- Auto layout and responsive constraints
- Components, instances, variants, and overrides
- Variables, modes, and published libraries
- Developer inspection and asset download

Exit criterion: a product team can operate a shared design system across projects.

### Milestone 4 — platform and scale

- Prototype interactions and presentation
- Plugin sandbox and public API
- Desktop wrapper and robust offline mode
- Billing, enterprise administration, SSO, SCIM, and audit logs
- GPU renderer and large-document optimization where metrics require it

Exit criterion: the platform supports external developers and enterprise operational controls.

## 19. Team evolution

An effective early team is three to five senior contributors covering product design, graphics/frontend, backend/realtime, and infrastructure. As the product grows, establish clear ownership for:

- Editor interaction and UI
- Graphics, geometry, and text
- Collaboration and document storage
- Design systems and layout
- Platform, identity, and billing
- Reliability, security, and developer ecosystem

The graphics engine and collaboration protocol require focused ownership; treating either as incidental application code creates long-term risk.

## 20. Architectural rules

1. The document model is independent of the UI framework.
2. The renderer never becomes the source of truth.
3. One user gesture maps to one semantic transaction.
4. Persistent document state is separate from presence and view state.
5. All imported content is untrusted and bounded.
6. Server-side authorization protects every mutation and asset.
7. Schema migrations are explicit, tested, and reversible through retained snapshots.
8. Performance decisions are based on representative documents and budgets.
9. Hosted export uses immutable snapshot references.
10. Product milestones remain vertical, usable slices rather than isolated infrastructure projects.
