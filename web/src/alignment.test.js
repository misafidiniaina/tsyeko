import test from "node:test";
import assert from "node:assert/strict";

import {
  ALIGNMENTS,
  calculateAlignmentDeltas,
  calculateDistributionDeltas,
  createAlignmentGuide,
  createSpacingGuides,
  DISTRIBUTION_AXES,
} from "./alignment.js";

function item(id, x, y, width, height) {
  return { id, bounds: { x, y, width, height } };
}

test("alignment deltas align AABB edges without mutating input", () => {
  const items = [
    item("a", 10, 20, 30, 40),
    item("b", 55, 5, 20, 10),
    item("c", -5, 45, 10, 25),
  ];
  const original = structuredClone(items);

  assert.deepEqual(calculateAlignmentDeltas(items, ALIGNMENTS.LEFT), [
    { id: "a", dx: -15, dy: 0 },
    { id: "b", dx: -60, dy: 0 },
    { id: "c", dx: 0, dy: 0 },
  ]);
  assert.deepEqual(calculateAlignmentDeltas(items, ALIGNMENTS.BOTTOM), [
    { id: "a", dx: 0, dy: 10 },
    { id: "b", dx: 0, dy: 55 },
    { id: "c", dx: 0, dy: 0 },
  ]);
  assert.deepEqual(items, original);
});

test("center alignment uses the complete selection bounds", () => {
  const items = [item("a", 0, 10, 20, 20), item("b", 80, 30, 40, 10)];

  assert.deepEqual(calculateAlignmentDeltas(items, ALIGNMENTS.HORIZONTAL_CENTER), [
    { id: "a", dx: 50, dy: 0 },
    { id: "b", dx: -40, dy: 0 },
  ]);
  assert.deepEqual(calculateAlignmentDeltas(items, ALIGNMENTS.VERTICAL_CENTER), [
    { id: "a", dx: 0, dy: 5 },
    { id: "b", dx: 0, dy: -10 },
  ]);
});

test("horizontal distribution creates equal gaps and keeps outer layers fixed", () => {
  const items = [
    item("middle", 70, 0, 30, 10),
    item("last", 180, 0, 20, 10),
    item("first", 0, 0, 20, 10),
  ];

  assert.deepEqual(calculateDistributionDeltas(items, DISTRIBUTION_AXES.HORIZONTAL), [
    { id: "first", dx: 0, dy: 0 },
    { id: "middle", dx: 15, dy: 0 },
    { id: "last", dx: 0, dy: 0 },
  ]);
});

test("vertical distribution supports different layer heights", () => {
  const items = [
    item("a", 0, 0, 10, 10),
    item("b", 0, 20, 10, 20),
    item("c", 0, 80, 10, 10),
    item("d", 0, 130, 10, 30),
  ];

  assert.deepEqual(calculateDistributionDeltas(items, DISTRIBUTION_AXES.VERTICAL), [
    { id: "a", dx: 0, dy: 0 },
    { id: "b", dx: 0, dy: 20 },
    { id: "c", dx: 0, dy: 10 },
    { id: "d", dx: 0, dy: 0 },
  ]);
});

test("distribution requires three layers", () => {
  const items = [item("a", 0, 0, 10, 10), item("b", 30, 0, 10, 10)];
  assert.deepEqual(calculateDistributionDeltas(items, DISTRIBUTION_AXES.HORIZONTAL), []);
});

test("feedback guides describe the aligned span and adjacent spacing", () => {
  const items = [item("a", 0, 10, 20, 20), item("b", 50, 0, 30, 40)];

  assert.deepEqual(createAlignmentGuide(items, ALIGNMENTS.TOP), {
    type: "alignment",
    axis: "y",
    value: 0,
    start: 0,
    end: 80,
  });
  assert.deepEqual(createSpacingGuides(items, DISTRIBUTION_AXES.HORIZONTAL), [{
    type: "spacing",
    axis: "x",
    start: 20,
    end: 50,
    cross: 20,
    value: 30,
  }]);
});
