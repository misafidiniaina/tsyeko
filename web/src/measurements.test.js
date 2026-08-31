import assert from "node:assert/strict";
import test from "node:test";

import { createDistanceGuides, createNearestSpacingGuides } from "./measurements.js";
import { createNode, getNodeAABB, NODE_TYPES } from "./model.js";

test("measures the visible gap between separate sibling bounds", () => {
  assert.deepEqual(
    createDistanceGuides(
      { x: 20, y: 10, width: 20, height: 20 },
      { x: 70, y: 0, width: 30, height: 40 },
      "target",
    ),
    [{
      type: "distance",
      axis: "x",
      start: 40,
      end: 70,
      cross: 20,
      value: 30,
      targetId: "target",
    }],
  );
});

test("measures all four insets when a layer is inside a frame", () => {
  assert.deepEqual(
    createDistanceGuides(
      { x: 20, y: 30, width: 50, height: 40 },
      { x: 0, y: 0, width: 200, height: 120 },
      "frame",
    ),
    [
      { type: "distance", axis: "x", start: 0, end: 20, cross: 50, value: 20, targetId: "frame" },
      { type: "distance", axis: "x", start: 70, end: 200, cross: 50, value: 130, targetId: "frame" },
      { type: "distance", axis: "y", start: 0, end: 30, cross: 45, value: 30, targetId: "frame" },
      { type: "distance", axis: "y", start: 70, end: 120, cross: 45, value: 50, targetId: "frame" },
    ],
  );
});

test("chooses the nearest sibling gap on each axis within the display range", () => {
  const source = { x: 50, y: 50, width: 20, height: 20 };
  const targets = [
    { id: "far", bounds: { x: 200, y: 50, width: 20, height: 20 } },
    { id: "left", bounds: { x: 10, y: 50, width: 20, height: 20 } },
    { id: "below", bounds: { x: 50, y: 100, width: 20, height: 10 } },
  ];

  assert.deepEqual(createNearestSpacingGuides(source, targets, 80), [
    { type: "distance", axis: "x", start: 30, end: 50, cross: 60, value: 20, targetId: "left" },
    { type: "distance", axis: "y", start: 70, end: 100, cross: 60, value: 30, targetId: "below" },
  ]);
  assert.deepEqual(createNearestSpacingGuides(source, targets, 15), []);
});

test("ignores overlapping and malformed measurement bounds", () => {
  assert.deepEqual(
    createDistanceGuides(
      { x: 0, y: 0, width: 30, height: 30 },
      { x: 10, y: 10, width: 30, height: 30 },
    ),
    [],
  );
  assert.deepEqual(createDistanceGuides(null, { x: 0, y: 0, width: 10, height: 10 }), []);
});

test("accepts rotation-aware layer bounds", () => {
  const rotated = createNode(NODE_TYPES.RECTANGLE, 40, 40, {
    width: 100,
    height: 20,
    rotation: 90,
  });
  const bounds = getNodeAABB(rotated);
  const [guide] = createDistanceGuides(bounds, { x: 150, y: 0, width: 20, height: 120 }, "peer");

  assert.ok(Math.abs(bounds.width - 20) < 0.0001);
  assert.ok(Math.abs(bounds.height - 100) < 0.0001);
  assert.equal(guide.axis, "x");
  assert.ok(Math.abs(guide.value - 50) < 0.0001);
});
