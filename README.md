# Tsyaiko

Tsyaiko is a runnable first slice of a Figma-style interface design tool. It is intentionally dependency-free: the editor uses browser-native Canvas 2D and ES modules, while a small Go server embeds and serves the complete application.

This repository is an MVP foundation, not a claim of feature parity with Figma. Its boundaries are designed so the renderer, history system, persistence layer, and future collaboration protocol can evolve independently.

## Run it

Requirements:

- Go 1.22 or newer
- A modern Chromium, Firefox, or Safari browser

```bash
npm run dev
```

Open <http://localhost:8080>.

The `npm` command does not install packages; it is only a convenient script runner. You can also use:

```bash
GOCACHE=$PWD/.cache/go-build go run .
```

## What works today

- Infinite dotted canvas with smooth pan and cursor-centered zoom
- Multiple pages with creation, switching, renaming, duplication, and deletion
- Independent pan/zoom state and canvas background for every page
- Frames, groups, rectangles, ellipses, cubic Bézier vector paths, and editable text
- Non-destructive Union, Subtract, Intersect, and Exclude Boolean containers with editable ordered sources
- Mask groups with an explicit bottom mask source, editable clipped content, nesting, reordering, and release workflows
- Composite-aware Canvas rendering, hit testing, paint/effect stacks, expanded strokes, PNG output, and structured SVG masks
- Pen tool for open/closed paths, click-drag curve handles, 45-degree Shift constraints, and click-first-point closure
- Direct vector editing with draggable anchors and handles, mirrored/free controls, corner/smooth conversion, curve-preserving segment insertion, anchor deletion, path reversal, and fill rules
- Editable compound vector contours, destructive Boolean flattening, and miter-limited stroke outlining with rotation-safe geometry
- Hierarchical frame/group/Boolean/mask parenting with nested clipping and inherited visibility, locking, and opacity
- Horizontal and vertical Auto Layout frames with ordered flow, wrapping, per-side padding, gaps, primary/counter-axis and text baseline alignment, intrinsic text hug sizing, fill children, and min/max dimensions
- Flow/absolute child positioning plus left, right, center, stretch, and scale constraints for responsive frame resizing
- Local reusable components with main sources, grouped variant sets, Inspector variant switching, linked instances, visual/content overrides, reset, and detach
- Content-addressed PNG, JPEG, WebP, GIF, WOFF, and WOFF2 assets with SHA-256 deduplication, integrity repair, usage tracking, and document quotas
- Ordered fill and stroke stacks with solid, linear, radial, and angular paints
- Ordered effects with data-driven drop shadows and layer blur
- Browser-native text shaping and metrics, embedded document fonts, and editable rich-text color/weight/style ranges
- Selection, marquee selection, multi-selection, movement, resize, and rotation
- Multi-selection edge/center alignment and equal-gap distribution with temporary on-canvas measurements
- Unified multi-selection transform box with corner/edge resize, shared-pivot rotation, Shift aspect/angle constraints, Alt center-resize, live angle feedback, and undo/redo
- Numeric multi-selection X/Y/W/H Inspector controls with optional aspect-ratio locking and one-click ±90° rotation
- Shift-constrained drawing and transforms
- Alt-centered shape drawing and resizing
- Smart edge and center snapping while moving layers
- Rotation-aware live sibling-gap measurements plus Alt/Option distance inspection against hovered layers and parent frames
- Persistent per-page rulers with adaptive ticks, draggable horizontal/vertical guides, exact guide positions, and undo/redo
- Configurable per-page grids with visibility controls and optional snap-to-grid behavior
- Collapsible nested layers panel with visibility and locking
- Inspector for geometry, paints, effects, opacity, stroke, corners, and typography
- Recursive layer ordering, grouping/ungrouping, duplication, copy/paste, nudging, and deletion
- Undo and redo with bounded, labeled command deltas
- Bounds-local composite caching, viewport culling, dirty-region redraws, and rolling render-performance diagnostics
- Local-first autosave through IndexedDB, with automatic localStorage migration and fallback
- Durable hosted snapshots with revision-checked autosave, live room updates, online counts, local fallback, and conflict detection
- JSON import/export, SVG export, and high-resolution PNG export
- Prototype preview surface
- Responsive editor shell
- Sanitized, cycle-safe v12 document imports with automatic v1–v11 migration
- Embedded Go server with a health endpoint and security headers

## Useful shortcuts

| Action | Shortcut |
|---|---|
| Move tool | `V` |
| Hand tool | `H` |
| Frame | `F` |
| Rectangle | `R` |
| Ellipse | `O` |
| Pen | `P` |
| Text | `T` |
| Temporary pan | `Space` + drag |
| Zoom | `Ctrl/Cmd` + wheel |
| Undo / redo | `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` |
| Duplicate | `Ctrl/Cmd+D` |
| Copy / paste | `Ctrl/Cmd+C` / `Ctrl/Cmd+V` |
| Group / ungroup | `Ctrl/Cmd+G` / `Ctrl/Cmd+Shift+G` |
| Wrap in Auto Layout | `Shift+A` |
| Create component | `Ctrl/Cmd+Alt+K` |
| Boolean Union | `Ctrl/Cmd+Alt+U` |
| Boolean Subtract | `Ctrl/Cmd+Alt+S` |
| Boolean Intersect | `Ctrl/Cmd+Alt+I` |
| Boolean Exclude | `Ctrl/Cmd+Alt+X` |
| Create mask | `Ctrl/Cmd+Alt+M` |
| Delete | `Backspace` or `Delete` |
| Nudge | Arrow keys; hold `Shift` for 10 px |
| Constrain resize or rotation | Hold `Shift` while dragging a selection handle |
| Resize from the center | Hold `Alt` while dragging a selection handle |
| Inspect layer distances | Hold `Alt/Option` while pointing at or transforming layers |
| Toggle rulers | `Shift+R` |
| Fit document | `1` |
| Fit selection | `2` |
| Actual size | `0` |
| Finish an open pen path | `Enter` or double-click |
| Close a pen path | Click its first anchor |
| Create Bézier handles | Drag while placing a pen anchor |
| Edit selected text or vector | `Enter` |
| Insert vector anchor | Double-click or `Alt`-click a segment |
| Toggle corner/smooth anchor | Double-click an anchor |
| Disconnect a Bézier handle | `Alt`-drag the handle |
| Delete selected vector anchor | `Backspace` or `Delete` |

## Responsive layout workflow

Select sibling layers and press `Shift+A`, or use the horizontal/vertical Auto Layout buttons in the inspector. The new frame hugs its content and orders children by their visual position. A selected Auto Layout frame exposes:

- Horizontal or vertical flow
- Fixed, hug, and parent-fill sizing where valid
- Gap and independent top/right/bottom/left padding
- Start, center, end, space-between, and stretch alignment
- Text/control baseline alignment for horizontal rows
- Layers-order flow with hidden layers excluded
- Optional row/column wrapping within fixed main-axis bounds

Select a child to choose fixed/fill sizing or switch it to absolute positioning. Children of ordinary frames—and absolute children of Auto Layout frames—expose horizontal and vertical constraints that are evaluated from the frame geometry at the start of each resize. Canvas, PNG, and SVG all consume the same resolved geometry.

Text children can hug their natural width and wrapped height. Line breaking is shared by layout, Canvas, and SVG export so text boxes resolve consistently as content, font size, or available width changes.

Every resizable layer also exposes minimum and maximum width and height in the Position inspector. These limits apply to direct canvas resizing, numeric size edits, hug frames, stretched children, and fill-space distribution. When a fill child reaches a limit, remaining space is redistributed among the other fill children.

## Component workflow

Select one or more sibling layers and choose **Create component** from Assets, or press `Ctrl/Cmd+Alt+K`. The selected source stays on the canvas as the main component. Assets lists every local component; click the main area of a card to insert a linked instance at the viewport center, or use its target action to reveal the main component.

Edits to a main component propagate to its instances. Text, visibility, paints, effects, typography, image content, and supported layout settings can be changed on an instance as local overrides. The Inspector lists each overridden layer/property, supports resetting one override or all overrides, and can swap the instance to another local component. A swap keeps outer placement and transfers overrides when the destination has a matching layer hierarchy, type, name, and sibling occurrence. Use **Detach instance** to make an independent layer tree. Free resize, rotate, and structural edits remain intentionally unavailable on linked instances; make those changes on the main component or detach first. Components and variants are local to the document for now—there are no published libraries or remote updates yet.

To create variants, select at least two main components and choose **Combine as variants** in Assets or **Combine as variant set** in the multi-selection Inspector. Names such as `Button / Primary` create one `Variant` control. A complete matrix such as `Button / State=Hover, Size=Large` creates separate `State` and `Size` controls. Assets groups the members under one set, and instance Inspector controls switch to available combinations while preserving compatible overrides and placement. Variant sets can be dissolved back into independent local components.

## Test it

```bash
npm test
npm run check
npm run test:browser
```

The unit suite covers document migration and sanitization, canvas-aid and distance-measurement geometry, content-addressed assets and embedded fonts, command history, alignment/distribution and transform geometry, render caches and profiling, rich text, compound/outlined/fuzzed geometry, component synchronization, local variants, nested Auto Layout, frame constraints, SVG parity, Boolean/mask geometry, the HTTP health endpoint, and embedded static delivery. The browser smoke test starts an isolated server and Chromium profile, then verifies multi-selection arrangement, transform handles, Alt distance inspection, exact geometry fields, ratio-locked scaling and quick rotation, rulers, draggable guides, custom grid snapping, the layout inspector, responsive resizing, undo/redo, v12 persistence, local component/variant workflows, all four Boolean modes and mask intersection with Canvas and rasterized-SVG pixel samples, vector editing, paint stacks, images, grouping, autosave, and reload persistence. Set `CHROMIUM_BIN` if Chromium is not in a standard location.

## Hosted snapshot workflow

The development server exposes `POST /v1/files`, `GET /v1/files`, `GET /v1/files/{id}`, and revision-checked `PATCH /v1/files/{id}`. Snapshots are written atomically under `data/` by default; choose another directory with `-data-dir`.

After creating a file through the API, open `/?file=file_…`. The editor loads that snapshot and sends later document changes with its current revision in `If-Match`. A live server-sent event room reports online sessions and published revisions. Clean editors automatically load a remote revision; editors with unsaved local work stop remote publishing and preserve that work for explicit reconciliation. A stale save also receives `409 Conflict`, and network failures retain a local browser copy.

This API is currently a development collaboration foundation. It has document validation, payload limits, safe IDs, atomic snapshots, optimistic concurrency, room presence counts, and live revision notifications, but no accounts or authorization yet. It synchronizes complete revisions rather than granular concurrent operations. Do not expose it to untrusted networks.

## Project structure

```text
.
├── main.go                  Embedded static server and health API
├── main_test.go             Go HTTP tests
├── hosted_files.go          Durable hosted snapshot store and revision model
├── web/
│   ├── index.html           Accessible editor shell
│   ├── styles.css           Product UI and responsive layout
│   └── src/
│       ├── app.js           Editor controller and interactions
│       ├── alignment.js     Multi-selection alignment, distribution, and guide geometry
│       ├── canvas-aids.js   Persistent guide, grid-snap, and ruler geometry
│       ├── measurements.js  Live sibling-gap and parent-distance geometry
│       ├── transform.js     Shared selection bounds, resize, and rotation geometry
│       ├── model.js         Document schema and geometry
│       ├── components.js    Local component and linked-instance synchronization
│       ├── layout.js        Auto Layout and frame constraints
│       ├── text.js          Deterministic text measurement and line wrapping
│       ├── vector.js        Cubic path geometry and transformations
│       ├── assets.js        Content-addressed image/font asset registry
│       ├── fonts.js         Embedded browser-font loading
│       ├── geometry.js      Boolean flattening and stroke outlining
│       ├── history.js       Reversible command-delta history
│       ├── hosted.js        Hosted file loading and revision-checked saving
│       ├── render-cache.js  Bounds cache and frame profiling primitives
│       ├── renderer.js      Dirty-region Canvas renderer and hit testing
│       ├── export.js        SVG/JSON/download support
│       ├── persistence.js   IndexedDB storage and migration fallback
│       ├── layout.test.js   Responsive layout unit tests
│       ├── alignment.test.js Arrangement geometry unit tests
│       ├── canvas-aids.test.js Canvas-aid geometry unit tests
│       ├── measurements.test.js Distance and spacing geometry unit tests
│       ├── transform.test.js Multi-selection transform unit tests
│       ├── components.test.js Component and instance unit tests
│       ├── model.test.js    Document and export unit tests
│       └── vector.test.js   Bézier geometry unit tests
├── scripts/
│   └── browser-smoke.mjs    Dependency-free Chromium integration test
└── docs/
    └── ARCHITECTURE.md      Production architecture and delivery roadmap
```

## Current product boundary

The MVP stores one hierarchical, multi-page document and content-addressed image/font assets locally, with an optional durable hosted snapshot API. Compound cubic paths, non-destructive and flattened Booleans, silhouette masks, wrapping and baseline-aware Auto Layout, browser-measured rich text, frame constraints, local linked components, variant sets, and per-page rulers/guides/grids are implemented. The current browser-native text pipeline is internally consistent but does not yet guarantee identical shaping across browser engines or a future server exporter. Stroke outlines are high-resolution polygonal approximations rather than exact Bézier offset curves. Bounds-local Canvas caches and dirty redraws improve ordinary editing, but there is no spatial index or GPU renderer for very large scenes. Rotated Auto Layout frames, nested component composition, typed component properties, published libraries, and remote library updates remain out of scope. There is also no account system, authorization model, remote database, WebSocket presence, or multiplayer operation stream yet. These are explicit follow-on milestones described in [the architecture document](docs/ARCHITECTURE.md).

## Core design decision

The saved document contains design objects, never pixels. Rendering is a projection of that model:

```text
Document model → interaction/history → renderer → Canvas
       └────────────── export pipeline ──────┘
```

That separation is what allows Canvas 2D to be replaced by WebGL/WebGPU and the local command stream to be promoted to collaborative operations or CRDT transactions without changing the file format or inspector UI wholesale.
