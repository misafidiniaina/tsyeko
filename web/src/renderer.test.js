import assert from "node:assert/strict";
import test from "node:test";

import { CanvasRenderer } from "./renderer.js";

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
