import test from "node:test";
import assert from "node:assert/strict";

import {
  ALIGNMENTS,
  calculateAlignmentDeltas,
  calculateDistributionDeltas,
  createAlignmentGuide,
  createSpacingGuides,
  DISTRIBUTION_AXES,
  findSmartSpacingSnaps,
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

test("smart spacing extends an existing rhythm and exposes every repeated gap", () => {
  const references = [
    item("a", 0, 10, 20, 20),
    item("b", 40, 10, 20, 20),
    item("c", 80, 10, 20, 20),
  ];
  const original = structuredClone(references);

  const snaps = findSmartSpacingSnaps(
    { x: 123, y: 10, width: 20, height: 20 },
    references,
    4,
  );

  assert.equal(snaps.x.delta, -3);
  assert.equal(snaps.x.gap, 20);
  assert.deepEqual(snaps.x.guides.map((guide) => [guide.start, guide.end, guide.value]), [
    [20, 40, 20],
    [60, 80, 20],
    [100, 120, 20],
  ]);
  assert.equal(snaps.y, null);
  assert.deepEqual(references, original);
});

test("smart spacing centers a moving layer between two neighbors", () => {
  const snaps = findSmartSpacingSnaps(
    { x: 56, y: 0, width: 20, height: 20 },
    [item("left", 0, 0, 20, 20), item("right", 100, 0, 20, 20)],
    6,
  );

  assert.equal(snaps.x.delta, -6);
  assert.equal(snaps.x.gap, 30);
  assert.deepEqual(snaps.x.guides.map((guide) => [guide.start, guide.end, guide.value]), [
    [20, 50, 30],
    [70, 100, 30],
  ]);
});

test("smart spacing ignores other rows and candidates that overlap a sibling", () => {
  const references = [
    item("a", 0, 0, 20, 20),
    item("b", 40, 0, 20, 20),
    item("blocker", 80, 0, 20, 20),
    item("other-row", 120, 100, 20, 20),
  ];

  const snaps = findSmartSpacingSnaps(
    { x: 82, y: 0, width: 20, height: 20 },
    references,
    4,
  );

  assert.equal(snaps.x, null);
  assert.equal(snaps.y, null);
});
