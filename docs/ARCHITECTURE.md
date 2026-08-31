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
├── Deterministic Auto Layout and frame-constraint engine
├── Local component source/instance synchronizer
├── Snapshot history
├── Hierarchy-aware Canvas 2D renderer
│   ├── Porter–Duff Boolean composition
│   └── nested mask/effect surfaces
└── SVG/PNG/JSON exporters
          │
          ▼
Embedded Go HTTP server
├── static assets
├── GET /api/health
├── revision-checked /v1/files snapshot API
├── atomic development snapshot storage
├── server-sent file rooms for presence and revision events
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

The current v10 file format is a versioned, multi-page JSON document with flat storage, explicit parent relationships, responsive-layout metadata, paint definitions, effects, cubic Bézier vector paths, ordered Boolean/mask containers, and local component/variant records. Versions 1–9 migrate automatically. Imports repair dangling parents, reject non-container parents, break cycles, sanitize layout/anchor/control/paint/effect/composite/component values, dissolve undersized variant sets, make duplicate variant combinations deterministic, and restore parent-before-child ordering:

```json
{
  "version": 10,
  "id": "document_…",
  "name": "Untitled design",
  "background": "#101114",
  "componentSets": [
    {
      "id": "component-set_…",
      "name": "Button",
      "propertyNames": ["State", "Size"]
    }
  ],
  "components": [
    {
      "id": "component_…",
      "name": "Button / Primary",
      "sourcePageId": "page_…",
      "sourceNodeId": "frame_…",
      "componentSetId": "component-set_…",
      "variantProperties": { "State": "Default", "Size": "Large" },
      "createdAt": "2026-08-30T00:00:00.000Z",
      "updatedAt": "2026-08-30T00:00:00.000Z"
    }
  ],
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
          "cornerRadius": 0,
          "layoutMode": "horizontal",
          "layoutGap": 24,
          "paddingTop": 32,
          "paddingRight": 32,
          "paddingBottom": 32,
          "paddingLeft": 32,
          "primaryAxisAlign": "start",
          "counterAxisAlign": "center",
          "layoutSizingHorizontal": "fixed",
          "layoutSizingVertical": "hug"
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
          "layoutPositioning": "auto",
          "layoutSizingHorizontal": "fill",
          "layoutSizingVertical": "fixed",
          "constraintHorizontal": "left-right",
          "constraintVertical": "top",
          "shadow": {
            "enabled": true,
            "color": "#000000",
            "opacity": 0.24,
            "offsetX": 0,
            "offsetY": 8,
            "blur": 24
          }
        },
        {
          "id": "vector_…",
          "type": "vector",
          "name": "Icon",
          "parentId": "frame_…",
          "x": 460,
          "y": 100,
          "width": 80,
          "height": 72,
          "rotation": 0,
          "opacity": 1,
          "visible": true,
          "locked": false,
          "fill": "#8b5cf6",
          "stroke": "#5b21b6",
          "strokeWidth": 2,
          "vectorPoints": [
            {
              "x": 0,
              "y": 24,
              "in": null,
              "out": { "x": 30, "y": 0 },
              "handleMode": "free"
            },
            {
              "x": 80,
              "y": 24,
              "in": { "x": 54, "y": 46 },
              "out": null,
              "handleMode": "free"
            },
            {
              "x": 18,
              "y": 72,
              "in": null,
              "out": null,
              "handleMode": "corner"
            }
          ],
          "vectorClosed": true,
          "vectorFillRule": "nonzero"
        }
      ]
    }
  ]
}
```

### 5.1 Local component semantics

Components reuse the normal scene-node types rather than introducing a separate renderer type. A component record identifies a main source root by page and node ID. Its root is tagged `componentRole: "main"`; descendants are tagged `"source"`. An inserted instance is a concrete cloned subtree with stable local IDs, `componentRole: "instance"` on the root, `"instance-child"` on descendants, and `componentSourceId` links back to source nodes.

The instance root owns a sparse `componentOverrides` map keyed by source-node ID. Supported visual/content properties are sanitized, compared to the source, exposed as individual Inspector entries, and applied after source synchronization. Source edits—including adding or removing source descendants—are rebuilt into every instance while the instance root retains its external placement and parent-layout relationship. A property can be reset independently or the entire map can be cleared; detach strips component metadata while preserving rendered geometry.

An instance can swap to another local component without changing the document schema. The swap preserves its outer placement and reuses local instance IDs where source layers match by hierarchy, node type, layer name, and same-name sibling occurrence. Compatible overrides are remapped to the destination source IDs; overrides without a semantic destination are discarded and reported to the UI. This provides Canvas, SVG, PNG, hit testing, Auto Layout, history, and persistence compatibility without a parallel scene graph.

A local component set records an ordered list of variant property names; each member component stores one value per property. Combining names such as `Button / Primary` produces a one-dimensional `Variant` set, while names such as `Button / State=Hover, Size=Large` infer a multi-property matrix. Inspector controls expose only values that have a valid component for the current values on every other axis. Switching a variant delegates to semantic instance swapping, so placement and compatible overrides survive. Assets groups members by set, and dissolving the set removes only variant metadata.

### 5.2 Composite node semantics

Boolean and mask results are saved as scene structure, never flattened pixels:

```json
{
  "id": "boolean_…",
  "type": "boolean",
  "booleanOperation": "subtract",
  "parentId": "group_…",
  "fill": "#7c3aed",
  "stroke": "#111111",
  "strokeWidth": 8
}
```

Direct children retain their own IDs, geometry, paints, and effects. Array/sibling order is bottom-to-top and has semantic meaning:

- Union combines every visible source.
- Subtract keeps the first source and removes every later source.
- Intersect keeps regions present in every source.
- Exclude keeps regions covered by an odd number of sources.
- A mask uses its first direct child as the silhouette and clips all later children.
- Releasing a Boolean or mask removes only the container and restores its direct children to the container's parent.

The composite owns the result paint, stroke, opacity, and effect. Source paint remains available for later editing or release but does not color Boolean geometry. Moving, resizing, rotating, duplicating, locking, hiding, deleting, and reordering a composite operate recursively without changing source IDs.

Canvas rendering creates alpha surfaces for each source and combines them with `source-over`, `destination-out`, `destination-in`, or `xor`. Result strokes are expanded from the combined alpha boundary, then the fill and effect are projected once. SVG export retains structure with `<mask>` definitions and uses `<feMorphology operator="dilate">` for the expanded stroke. Hit testing evaluates the same Boolean algebra, so transparent Subtract/Exclude holes do not select the composite.

Production evolution:

- Move from world-space child geometry to consistently decomposed local transforms or matrices
- Add explicit sibling ordering when collaboration requires ordering independent of array position
- Extend vectors with editable compound contours, destructive flattening, and precision offset/outline geometry
- Add multiple paint stacks, radial/angular gradients, and blur effects
- Add rich-text ranges and font references
- Add typed component properties, nested composition, richer variant authoring, and library publication
- Extend Auto Layout with wrapping, min/max dimensions, baseline alignment, and intrinsic text measurement
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

The current Canvas compositor intentionally uses viewport-sized temporary surfaces for correctness and simple nesting. Before large-document work, replace repeated allocation with pooled, bounds-local surfaces and dirty-region caches. Promote the same scene-composition contract to GPU render targets only after profiling shows that Canvas misses the stated budgets.

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

The v10 client implements layout as a deterministic function of document properties. A frame with horizontal or vertical Auto Layout flows its visible direct children in sibling order; hidden and absolute children are excluded. The implemented contract includes:

- Independent top, right, bottom, and left padding
- Optional horizontal row wrapping and vertical column wrapping
- Fixed gaps or primary-axis space-between distribution
- Start, center, and end alignment plus counter-axis stretch
- Deterministic text/control baseline alignment for horizontal rows
- Intrinsic text width and wrapped-height hug sizing with shared Canvas/SVG line breaking
- Fixed and fill child sizing
- Minimum and maximum dimensions across direct resizing, hug, stretch, and fill distribution
- Fixed, hug, and parent-fill sizing for nested Auto Layout frames
- Absolute children with responsive constraints
- Left, center, right, left+right, and scale horizontal constraints
- Top, center, bottom, top+bottom, and scale vertical constraints

Resolution runs deepest frames first and repeats to a bounded fixed point. A hugging parent can therefore consume a hugging child's intrinsic result, while a fill child can receive its allocation and then reflow its own descendants. Auto-bound groups, Booleans, and masks participate in positioning but continue deriving their size from their sources.

Frame constraints are calculated from immutable node snapshots captured at the start of each resize gesture. This prevents cumulative drift and permits nested frames to evaluate their own children after receiving a new box. Resolved geometry is committed to history and persistence, so Canvas, hit testing, PNG, and SVG use the same boxes.

The current engine is axis-aligned. Text widths and baselines use deterministic approximations until controlled font metrics are available. Rotated Auto Layout frames and incremental dirty-subtree invalidation remain future work. A hosted export worker must eventually run this same algorithm and controlled font metrics.

## 13. Components and design systems

The implemented local component slice includes:

- A component registry record with a main source page and root node
- Source and instance metadata on ordinary scene nodes, with stable source-node identity
- Linked instance synchronization across pages and document persistence
- Sparse, sanitized visual/content override maps
- Per-property and full reset, semantic instance swapping, and detach workflows
- Local one- or multi-property variant sets with inferred controls, valid-combination switching, grouped Assets display, and dissolution
- Assets-panel insertion/source navigation, Layers labels, inspector navigation, and transform/structural-edit guards

The current scope deliberately excludes nested component composition, typed component properties, custom variant-axis editing, published libraries, and remote library updates. Main-source geometry and structure remain authoritative; instances preserve only their outer placement/layout relationship until detached.

Production design systems still need:

- Typed component properties and richer variant authoring
- Published library versions and deliberate upgrades
- Variables with types, collections, modes, aliases, and scopes
- Remote dependencies, permissions, and immutable publication history

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
- Multi-page documents, page operations, and v1–v9 schema migration into v10
- Hierarchical frames and groups with recursive editing and cycle-safe imports
- Nested layers, frame clipping, and inherited visibility, locking, and opacity
- Linear-gradient fills and explicit drop-shadow effects with Canvas/SVG parity
- Open/closed cubic Bézier paths, pen-drag controls, direct anchor/handle editing, curve-preserving splits, fill rules, and SVG path export
- Non-destructive Union/Subtract/Intersect/Exclude containers with ordered editable sources and composite hit testing
- Nested silhouette mask groups, result effects, expanded Boolean strokes, and Canvas/PNG/SVG export parity
- Composite creation, operation switching, source-order labels, release workflows, keyboard commands, persistence, and browser pixel tests
- Horizontal/vertical Auto Layout, Shift+A wrapping, padding, gaps, alignment, fixed/hug/fill sizing, absolute children, and Layers feedback
- Responsive frame constraints with nested evaluation, resize snapshots, undo/redo, persistence, and Canvas/SVG geometry parity
- Local components with source records, linked instances, visible/property-level overrides, semantic swapping, local variant matrices, reset, detach, Assets insertion/navigation, and v10 persistence
- Per-page canvas appearance and view state
- Embedded raster image layers with cover/contain fitting
- IndexedDB persistence and compact localStorage recovery copies
- Selection and transforms
- Layers and inspector
- History and local autosave
- PNG, SVG, and JSON export
- Embedded development server

### Milestone 1 — structured editor

- Controlled font shaping and exact font metrics
- Editable compound contours, destructive Boolean flattening, precision stroke outlining, and geometry-kernel fuzz tests
- Bounds-local composite caches, dirty-region rendering, and large-scene profiling
- Multiple paint stacks, radial/angular gradients, and blur effects
- Better text shaping and rich-text ranges
- Command-based history
- Dedicated content-addressed asset records and storage quotas

Exit criterion: a designer can complete and export a small production UI without leaving the editor.

### Milestone 2 — hosted collaboration

- Durable file snapshots, optimistic revisions, live file-room events, online counts, clean-client updates, conflict detection, and local fallback (implemented foundation)
- Accounts, organizations, projects, and sharing
- PostgreSQL and object storage
- WebSocket rooms and presence
- Durable operations, reconnect, and compaction
- Comments, mentions, thumbnails, and version history

Exit criterion: a team can safely co-edit a file and recover from disconnects or browser restarts.

### Milestone 3 — professional design systems

- Typed component properties, advanced variant authoring, nested composition, and remote library dependencies
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
