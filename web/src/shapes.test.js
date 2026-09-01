import assert from "node:assert/strict";
import test from "node:test";

import {
  ARROWHEADS,
  cornerRadiusFromDrag,
  cornerRadiusFromPoint,
  getLineArrowheads,
  getParametricHandles,
  getParametricShapePoints,
  linePathData,
  parametricShapePathData,
  pointInParametricShape,
  starInnerRatioFromPoint,
} from "./shapes.js";

test("builds stable polygon and star geometry", () => {
  const polygon = { type: "polygon", width: 100, height: 80, polygonSides: 6, cornerRadius: 8 };
  const star = { type: "star", width: 100, height: 100, starPoints: 5, starInnerRatio: 0.4 };

  assert.equal(getParametricShapePoints(polygon).length, 6);
  assert.equal(getParametricShapePoints(star).length, 10);
  assert.match(parametricShapePathData(polygon, 10, 20), /^M .+ Q .+ Z$/);
  assert.equal(pointInParametricShape(polygon, { x: 50, y: 40 }), true);
  assert.equal(pointInParametricShape(star, { x: 0, y: 100 }), false);
});

test("rounded polygon hit testing follows the rendered corner", () => {
  const polygon = {
    type: "polygon",
    width: 100,
    height: 100,
    polygonSides: 4,
    cornerRadius: 100,
    strokeWidth: 0,
  };

  assert.equal(pointInParametricShape(polygon, { x: 50, y: 50 }), true);
  assert.equal(pointInParametricShape(polygon, { x: 50, y: 2 }), false);
});

test("line geometry preserves direction and creates arrowheads", () => {
  const line = {
    type: "line",
    width: 120,
    height: 60,
    lineStartX: 1,
    lineStartY: 0,
    lineEndX: 0,
    lineEndY: 1,
    arrowStart: ARROWHEADS.CIRCLE,
    arrowEnd: ARROWHEADS.TRIANGLE,
    strokeWidth: 2,
  };

  assert.equal(linePathData(line), "M 120 0 L 0 60");
  assert.equal(getLineArrowheads(line).start.kind, ARROWHEADS.CIRCLE);
  assert.equal(getLineArrowheads(line).end.points.length, 3);
  assert.equal(pointInParametricShape(line, { x: 60, y: 30 }, 0), true);
  assert.equal(pointInParametricShape(line, { x: 60, y: 50 }, 0), false);
});

test("direct adjustment values clamp to useful parametric ranges", () => {
  const polygon = { type: "polygon", width: 100, height: 100, polygonSides: 4 };
  const star = { type: "star", width: 100, height: 100, starPoints: 5, starInnerRatio: 0.4 };

  assert.ok(cornerRadiusFromPoint(polygon, { x: 100, y: 0 }) > 0);
  assert.equal(
    Math.round(cornerRadiusFromDrag(polygon, { x: 60, y: 10 }, { x: 74.142, y: 24.142 })),
    20,
  );
  assert.equal(starInnerRatioFromPoint(star, { x: 50, y: 50 }), 0.08);
  assert.equal(starInnerRatioFromPoint(star, { x: 500, y: 500 }), 0.95);
  assert.deepEqual(
    getParametricHandles(polygon).map((handle) => handle.kind),
    ["polygon-sides", "corner-radius"],
  );
  assert.deepEqual(
    getParametricHandles(star).map((handle) => handle.kind),
    ["star-points", "corner-radius", "star-inner-ratio"],
  );
});
