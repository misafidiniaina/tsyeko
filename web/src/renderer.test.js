import assert from "node:assert/strict";
import test from "node:test";

import { CanvasRenderer } from "./renderer.js";
import { createNode, createPage, NODE_TYPES } from "./model.js";

test("selection overlays use exact layer bounds without inherited visual effects", () => {
  const strokeRects = [];
  const context = createSelectionContext(strokeRects);
  const renderer = {
    context,
    worldToScreen(point) {
      return point;
    },
    drawDimensions() {},
  };

  CanvasRenderer.prototype.drawSelectionOutline.call(
    renderer,
    { x: 10, y: 20, width: 100, height: 50, rotation: 0, locked: false },
    { x: 0, y: 0, zoom: 1 },
    true,
    false,
  );

  assert.deepEqual(strokeRects[0].rectangle, [-50, -25, 100, 50]);
  assert.equal(strokeRects[0].shadowColor, "transparent");
  assert.equal(strokeRects[0].shadowBlur, 0);
  assert.equal(strokeRects[0].filter, "none");
  assert.equal(strokeRects[0].globalCompositeOperation, "source-over");
});

test("active transforms and their cleanup frame use full redraws", () => {
  const renderer = {
    width: 800,
    height: 600,
    pixelRatio: 1,
    sceneInvalidated: false,
    previousRenderState: null,
  };
  const base = CanvasRenderer.prototype.captureRenderState.call(
    renderer,
    { nodes: [], background: "#101114" },
    [],
    { x: 0, y: 0, zoom: 1 },
    { activeTransform: true },
  );

  assert.equal(base.transient, true);
  renderer.previousRenderState = base;
  const settled = { ...base, transient: false };
  assert.deepEqual(
    CanvasRenderer.prototype.createDirtyPlan.call(renderer, settled),
    { full: true, skip: false, regions: [] },
  );
});

test("structural node changes force a full redraw that clears deleted shadows", () => {
  const renderer = {
    width: 800,
    height: 600,
    sceneInvalidated: false,
    previousRenderState: {
      baseKey: "same",
      transient: false,
      camera: { x: 0, y: 0, zoom: 1 },
      selectedIds: new Set(["deleted"]),
      nodes: new Map([["deleted", {
        signature: "before",
        bounds: { x: 20, y: 20, width: 200, height: 120 },
      }]]),
    },
  };
  const current = {
    baseKey: "same",
    transient: false,
    camera: { x: 0, y: 0, zoom: 1 },
    selectedIds: new Set(),
    nodes: new Map(),
  };

  assert.deepEqual(
    CanvasRenderer.prototype.createDirtyPlan.call(renderer, current),
    { full: true, skip: false, regions: [] },
  );
});

test("hit testing can look through the measured selection to its parent", () => {
  const page = createPage("Measurements");
  const frame = createNode(NODE_TYPES.FRAME, 0, 0, { width: 200, height: 120 });
  const child = createNode(NODE_TYPES.RECTANGLE, 40, 30, {
    width: 80,
    height: 40,
    parentId: frame.id,
  });
  page.nodes.push(frame, child);
  const renderer = {
    screenToWorld(point) {
      return point;
    },
  };

  const hit = CanvasRenderer.prototype.hitTest.call(
    renderer,
    page,
    { x: 60, y: 50 },
    { x: 0, y: 0, zoom: 1 },
    new Set([child.id]),
  );
  assert.equal(hit?.id, frame.id);
});

function createSelectionContext(strokeRects) {
  return {
    globalAlpha: 0.5,
    globalCompositeOperation: "multiply",
    filter: "blur(8px)",
    shadowColor: "#000000",
    shadowBlur: 16,
    shadowOffsetX: 4,
    shadowOffsetY: 8,
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    setLineDash() {},
    fillRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    arc() {},
    fill() {},
    strokeRect(...rectangle) {
      strokeRects.push({
        rectangle,
        shadowColor: this.shadowColor,
        shadowBlur: this.shadowBlur,
        filter: this.filter,
        globalCompositeOperation: this.globalCompositeOperation,
      });
    },
  };
}
