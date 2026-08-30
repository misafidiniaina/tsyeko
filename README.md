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
- Composite-aware Canvas rendering, hit testing, shadows, gradient fills, expanded strokes, PNG output, and structured SVG masks
- Pen tool for open/closed paths, click-drag curve handles, 45-degree Shift constraints, and click-first-point closure
- Direct vector editing with draggable anchors and handles, mirrored/free controls, corner/smooth conversion, curve-preserving segment insertion, anchor deletion, path reversal, and fill rules
- Hierarchical frame/group/Boolean/mask parenting with nested clipping and inherited visibility, locking, and opacity
- Horizontal and vertical Auto Layout frames with ordered flow, wrapping, per-side padding, gaps, primary/counter-axis alignment, hug sizing, fill children, and min/max dimensions
- Flow/absolute child positioning plus left, right, center, stretch, and scale constraints for responsive frame resizing
- Local reusable components with main sources, grouped variant sets, Inspector variant switching, linked instances, visual/content overrides, reset, and detach
- Embedded PNG, JPEG, WebP, and GIF image layers with cover/contain fitting
- Solid and editable linear-gradient fills with angle and color stops
- Data-driven drop shadows with color, opacity, offsets, and blur
- Selection, marquee selection, multi-selection, movement, resize, and rotation
- Shift-constrained drawing and transforms
- Alt-centered shape drawing and resizing
- Smart edge and center snapping while moving layers
- Collapsible nested layers panel with visibility and locking
- Inspector for geometry, paints, effects, opacity, stroke, corners, and typography
- Recursive layer ordering, grouping/ungrouping, duplication, copy/paste, nudging, and deletion
- Undo and redo with a bounded document history
- Local-first autosave through IndexedDB, with automatic localStorage migration and fallback
- JSON import/export, SVG export, and high-resolution PNG export
- Prototype preview surface
- Responsive editor shell
- Sanitized, cycle-safe v10 document imports with automatic v1–v9 migration
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
- Layers-order flow with hidden layers excluded
- Optional row/column wrapping within fixed main-axis bounds

Select a child to choose fixed/fill sizing or switch it to absolute positioning. Children of ordinary frames—and absolute children of Auto Layout frames—expose horizontal and vertical constraints that are evaluated from the frame geometry at the start of each resize. Canvas, PNG, and SVG all consume the same resolved geometry.

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

The unit suite covers document migration and sanitization, component source/instance synchronization, override inspection and reset, semantic swaps, local variant matrices, detach, nested Auto Layout, hug/fill sizing, alignment, frame constraints, SVG layout parity, cubic geometry, Boolean/mask geometry, hierarchy, history, the HTTP health endpoint, and embedded static delivery. The browser smoke test starts an isolated server and Chromium profile, then verifies the layout inspector, responsive resizing, undo/redo, v10 persistence, local component/variant creation, linked updates, override reset, Assets navigation, instance swapping and variant switching, detach, all four Boolean modes and mask intersection with Canvas and rasterized-SVG pixel samples, expanded strokes, pen-drag curves, paints, images, grouping, autosave, and reload persistence. Set `CHROMIUM_BIN` if Chromium is not in a standard location.

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
│       ├── components.js    Local component and linked-instance synchronization
│       ├── layout.js        Auto Layout and frame constraints
│       ├── vector.js        Cubic path geometry and transformations
│       ├── history.js       Undo/redo snapshots
│       ├── renderer.js      Canvas renderer and hit testing
│       ├── export.js        SVG/JSON/download support
│       ├── persistence.js   IndexedDB storage and migration fallback
│       ├── layout.test.js   Responsive layout unit tests
│       ├── components.test.js Component and instance unit tests
│       ├── model.test.js    Document and export unit tests
│       └── vector.test.js   Bézier geometry unit tests
├── scripts/
│   └── browser-smoke.mjs    Dependency-free Chromium integration test
└── docs/
    └── ARCHITECTURE.md      Production architecture and delivery roadmap
```

## Current product boundary

The MVP stores one hierarchical, multi-page document and embedded raster assets in the browser. Cubic paths, object-level non-destructive Booleans, silhouette masks, wrapping Auto Layout, frame constraints, min/max dimensions, local linked components, and local variant sets are implemented. Layout does not yet include baseline alignment, intrinsic text measurement, or rotated Auto Layout frames. Components do not yet support nested component composition, published libraries, remote updates, or typed component-property controls. True multi-contour path editing, destructive path flattening, precision offset curves, and a scalable cached/GPU compositor also remain future work. There is no account system, remote database, managed font asset pipeline, or multiplayer synchronization yet. These are explicit follow-on milestones described in [the architecture document](docs/ARCHITECTURE.md).

## Core design decision

The saved document contains design objects, never pixels. Rendering is a projection of that model:

```text
Document model → interaction/history → renderer → Canvas
       └────────────── export pipeline ──────┘
```

That separation is what allows Canvas 2D to be replaced by WebGL/WebGPU and snapshot history to be replaced by command operations or CRDT transactions without changing the file format or inspector UI wholesale.
