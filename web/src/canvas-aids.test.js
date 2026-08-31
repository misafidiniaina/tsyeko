import test from "node:test";
import assert from "node:assert/strict";

import {
  closestGridSnap,
  createGuide,
  GUIDE_AXES,
  normalizeGuides,
  rulerStep,
  snapGuidePosition,
} from "./canvas-aids.js";

test("normalizes safe, unique page guides", () => {
  let generated = 0;
  const guides = normalizeGuides([
    { id: "same", axis: GUIDE_AXES.VERTICAL, position: "120.5" },
    { id: "same", axis: GUIDE_AXES.HORIZONTAL, position: -40 },
    { id: "bad-axis", axis: "z", position: 20 },
    { id: "bad-position", axis: GUIDE_AXES.VERTICAL, position: "nope" },
  ], () => `generated_${++generated}`);

  assert.deepEqual(guides, [
    { id: "same", axis: "x", position: 120.5 },
    { id: "generated_1", axis: "y", position: -40 },
  ]);
  assert.throws(() => createGuide("z", 0, "guide"), /Unsupported guide axis/);
});

test("finds grid and object snaps within the active threshold", () => {
  assert.deepEqual(closestGridSnap([31, 50], 16, 2), { delta: 1, value: 32 });
  assert.equal(closestGridSnap([35], 16, 2), null);
  assert.equal(snapGuidePosition(99.2, [40, 100, 180], 2), 100);
  assert.equal(snapGuidePosition(99.24, [], 2), 99.2);
});

test("chooses readable 1/2/5 ruler intervals across zoom levels", () => {
  assert.equal(rulerStep(1), 100);
  assert.equal(rulerStep(2), 50);
  assert.equal(rulerStep(0.1), 1_000);
});
