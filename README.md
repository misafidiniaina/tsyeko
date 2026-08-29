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
- Frames, groups, rectangles, ellipses, and editable text
- Hierarchical frame/group parenting with nested clipping and inherited visibility, locking, and opacity
- Embedded PNG, JPEG, WebP, and GIF image layers with cover/contain fitting
- Selection, marquee selection, multi-selection, movement, resize, and rotation
- Shift-constrained drawing and transforms
- Alt-centered shape drawing and resizing
- Smart edge and center snapping while moving layers
- Collapsible nested layers panel with visibility and locking
- Inspector for geometry, color, opacity, stroke, corners, and typography
- Recursive layer ordering, grouping/ungrouping, duplication, copy/paste, nudging, and deletion
- Undo and redo with a bounded document history
- Local-first autosave through IndexedDB, with automatic localStorage migration and fallback
- JSON import/export, SVG export, and high-resolution PNG export
- Prototype preview surface
- Responsive editor shell
- Sanitized, cycle-safe v3 document imports with automatic v1/v2 migration
- Embedded Go server with a health endpoint and security headers

## Useful shortcuts

| Action | Shortcut |
|---|---|
| Move tool | `V` |
| Hand tool | `H` |
| Frame | `F` |
| Rectangle | `R` |
| Ellipse | `O` |
| Text | `T` |
| Temporary pan | `Space` + drag |
| Zoom | `Ctrl/Cmd` + wheel |
| Undo / redo | `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` |
| Duplicate | `Ctrl/Cmd+D` |
| Copy / paste | `Ctrl/Cmd+C` / `Ctrl/Cmd+V` |
| Group / ungroup | `Ctrl/Cmd+G` / `Ctrl/Cmd+Shift+G` |
| Delete | `Backspace` or `Delete` |
| Nudge | Arrow keys; hold `Shift` for 10 px |
| Fit document | `1` |
| Fit selection | `2` |
| Actual size | `0` |
| Edit selected text | `Enter` |

## Test it

```bash
npm test
npm run check
npm run test:browser
```

The unit suite covers document migration and sanitization, cycle-safe hierarchy, subtree operations, multi-page identity, geometry, rotated hit testing, history, SVG clipping/export, the HTTP health endpoint, and embedded static delivery. The browser smoke test starts an isolated server and Chromium profile, then verifies page creation, drawing, image import, grouping, nested layer collapse/expand, autosave, and reload persistence. Set `CHROMIUM_BIN` if Chromium is not in a standard location.

## Project structure

```text
.
├── main.go                  Embedded static server and health API
├── main_test.go             Go HTTP tests
├── web/
│   ├── index.html           Accessible editor shell
│   ├── styles.css           Product UI and responsive layout
│   └── src/
│       ├── app.js           Editor controller and interactions
│       ├── model.js         Document schema and geometry
│       ├── history.js       Undo/redo snapshots
│       ├── renderer.js      Canvas renderer and hit testing
│       ├── export.js        SVG/JSON/download support
│       ├── persistence.js   IndexedDB storage and migration fallback
│       └── model.test.js    JavaScript unit tests
├── scripts/
│   └── browser-smoke.mjs    Dependency-free Chromium integration test
└── docs/
    └── ARCHITECTURE.md      Production architecture and delivery roadmap
```

## Current product boundary

The MVP stores one hierarchical, multi-page document and embedded raster assets in the browser. It has no account system, remote database, true component instances, vector pen tool, font asset pipeline, auto layout, or multiplayer synchronization yet. These are explicit follow-on milestones described in [the architecture document](docs/ARCHITECTURE.md).

## Core design decision

The saved document contains design objects, never pixels. Rendering is a projection of that model:

```text
Document model → interaction/history → renderer → Canvas
       └────────────── export pipeline ──────┘
```

That separation is what allows Canvas 2D to be replaced by WebGL/WebGPU and snapshot history to be replaced by command operations or CRDT transactions without changing the file format or inspector UI wholesale.
